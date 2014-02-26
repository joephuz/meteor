var Fiber = Npm.require('fibers');
var Future = Npm.require('fibers/future');

var PHASE = {
  QUERYING: "QUERYING",
  FETCHING: "FETCHING",
  STEADY: "STEADY"
};

// OplogObserveDriver is an alternative to PollingObserveDriver which follows
// the Mongo operation log instead of just re-polling the query. It obeys the
// same simple interface: constructing it starts sending observeChanges
// callbacks (and a ready() invocation) to the ObserveMultiplexer, and you stop
// it by calling the stop() method.
OplogObserveDriver = function (options) {
  var self = this;
  self._usesOplog = true;  // tests look at this

  self._cursorDescription = options.cursorDescription;
  self._mongoHandle = options.mongoHandle;
  self._multiplexer = options.multiplexer;

  if (options.ordered) {
    throw Error("OplogObserveDriver only supports unordered observeChanges");
  }

  if (options.cursorDescription.options.limit) {
    // There are several properties ordered driver implements:
    // - _limit is a positive number
    // - _comparator is a function-comparator by which the query is ordered
    // - _unpublishedBuffer is non-null Min/Max Heap,
    //                      the empty buffer in STEADY phase implies that the
    //                      everything that matches the queries selector fits
    //                      into published set.
    // - _published - Min Heap (also implements IdMap methods)

    // We don't support $near and other geo-queries so it's OK to initialize the
    // comparator only once in the constructor.
    var sorter = new Minimongo.Sorter(options.cursorDescription.options.sort);
    var comparator = sorter.getComparator();
    var heapOptions = { IdMap: LocalCollection._IdMap };
    self._limit = self._cursorDescription.options.limit;
    self._comparator = comparator;
    self._unpublishedBuffer = new MinMaxHeap(comparator, heapOptions);
    // We need something that can find Max value in addition to IdMap interface
    self._published = new MaxHeap(comparator, heapOptions);
  } else {
    self._limit = 0;
    self._comparator = null;
    self._unpublishedBuffer = null;
    self._published = new LocalCollection._IdMap;
  }

  // Indicates if it is safe to insert a new document at the end of the buffer
  // for this query. i.e. it is known that there are no documents matching the
  // selector those are not in published or buffer.
  self._safeAppendToBuffer = false;

  self._stopped = false;
  self._stopHandles = [];

  Package.facts && Package.facts.Facts.incrementServerFact(
    "mongo-livedata", "observe-drivers-oplog", 1);

  self._registerPhaseChange(PHASE.QUERYING);

  var selector = self._cursorDescription.selector;
  self._matcher = options.matcher;
  var projection = self._cursorDescription.options.fields || {};
  self._projectionFn = LocalCollection._compileProjection(projection);
  // Projection function, result of combining important fields for selector and
  // existing fields projection
  self._sharedProjection = self._matcher.combineIntoProjection(projection);
  self._sharedProjectionFn = LocalCollection._compileProjection(
    self._sharedProjection);

  self._needToFetch = new LocalCollection._IdMap;
  self._currentlyFetching = null;
  self._fetchGeneration = 0;

  self._requeryWhenDoneThisQuery = false;
  self._writesToCommitWhenWeReachSteady = [];

  forEachTrigger(self._cursorDescription, function (trigger) {
    self._stopHandles.push(self._mongoHandle._oplogHandle.onOplogEntry(
      trigger, function (notification) {
        Meteor._noYieldsAllowed(function () {
          var op = notification.op;
          if (notification.dropCollection) {
            // Note: this call is not allowed to block on anything (especially
            // on waiting for oplog entries to catch up) because that will block
            // onOplogEntry!
            self._needToPollQuery();
          } else {
            // All other operators should be handled depending on phase
            if (self._phase === PHASE.QUERYING)
              self._handleOplogEntryQuerying(op);
            else
              self._handleOplogEntrySteadyOrFetching(op);
          }
        });
      }
    ));
  });

  // XXX ordering w.r.t. everything else?
  self._stopHandles.push(listenAll(
    self._cursorDescription, function (notification) {
      // If we're not in a write fence, we don't have to do anything.
      var fence = DDPServer._CurrentWriteFence.get();
      if (!fence)
        return;
      var write = fence.beginWrite();
      // This write cannot complete until we've caught up to "this point" in the
      // oplog, and then made it back to the steady state.
      Meteor.defer(function () {
        self._mongoHandle._oplogHandle.waitUntilCaughtUp();
        if (self._stopped) {
          // We're stopped, so just immediately commit.
          write.committed();
        } else if (self._phase === PHASE.STEADY) {
          // Make sure that all of the callbacks have made it through the
          // multiplexer and been delivered to ObserveHandles before committing
          // writes.
          self._multiplexer.onFlush(function () {
            write.committed();
          });
        } else {
          self._writesToCommitWhenWeReachSteady.push(write);
        }
      });
    }
  ));

  // Give _observeChanges a chance to add the new ObserveHandle to our
  // multiplexer, so that the added calls get streamed.
  Meteor.defer(function () {
    self._runInitialQuery();
  });
};

_.extend(OplogObserveDriver.prototype, {
  _addPublished: function (id, doc) {
    var self = this;
    var fields = _.clone(doc);
    delete fields._id;
    self._published.set(id, self._sharedProjectionFn(doc));
    self._multiplexer.added(id, self._projectionFn(fields));

    // After adding this document, the published set might be overflowed
    // (exceeding capacity specified by limit). If so, push the maximum element
    // to the buffer, we might want to save it in memory to reduce the amount of
    // Mongo lookups in the future.
    if (self._limit && self._published.size() > self._limit) {
      // XXX in theory the size of published is no more than limit+1
      if (self._published.size() !== self._limit + 1) {
        throw new Error("After adding to published, " +
                        (self._published.size() - self._limit) +
                        " documents are overflowing the set");
      }

      var overflowingDocId = self._published.maxElementId();
      var overflowingDoc = self._published.get(overflowingDocId);

      if (EJSON.equals(overflowingDocId, id)) {
        throw new Error("The document just added is overflowing the published set");
      }

      self._published.remove(overflowingDocId);
      self._multiplexer.removed(overflowingDocId);
      self._addBuffered(overflowingDocId, overflowingDoc);
    }
  },
  _removePublished: function (id) {
    var self = this;
    self._published.remove(id);
    self._multiplexer.removed(id);
    if (! self._limit)
      return;
    if (self._published.size() < self._limit) {
      // The unpublished buffer is empty iff published contains the whole
      // matching set, i.e. number of matching documents is less or equal to the
      // queries limit.
      if (! self._unpublishedBuffer.size()) {
        // Assertion of the statement above
        if (! self._safeAppendToBuffer && self._phase !== PHASE.QUERYING)
          throw new Error("At this phase, buffer can be empty only if published contains the whole matching set");
        return;
      }

      var newDocId = self._unpublishedBuffer.minElementId();
      var newDoc = self._unpublishedBuffer.get(newDocId);
      self._removeBuffered(newDocId);
      self._addPublished(newDocId, newDoc);
    }
  },
  _changePublished: function (id, oldDoc, newDoc) {
    var self = this;
    self._published.set(id, self._sharedProjectionFn(newDoc));
    var changed = LocalCollection._makeChangedFields(_.clone(newDoc), oldDoc);
    changed = self._projectionFn(changed);
    if (!_.isEmpty(changed))
      self._multiplexer.changed(id, changed);
  },
  _addBuffered: function (id, doc) {
    var self = this;
    self._unpublishedBuffer.set(id, self._sharedProjectionFn(doc));

    // If something is overflowing the buffer, we just remove it from cache
    if (self._unpublishedBuffer.size() > self._limit) {
      var maxBufferedId = self._unpublishedBuffer.maxElementId();

      self._unpublishedBuffer.remove(maxBufferedId);

      // Since something matching is removed from cache (both published set and
      // buffer), set flag to false
      self._safeAppendToBuffer = false;
    }
  },
  // Is called either to remove the doc completely from matching set or to move
  // it to the published set later.
  _removeBuffered: function (id) {
    var self = this;
    self._unpublishedBuffer.remove(id);
    // To keep the contract "buffer is never empty in STEADY phase unless the
    // everything matching fits into published" true, we poll everything as soon
    // as we see the buffer becoming empty.
    if (! self._unpublishedBuffer.size() && ! self._safeAppendToBuffer)
      self._needToPollQuery();
  },
  // Called when a document has joined the "Matching" results set.
  // Takes responsibility of keeping _unpublishedBuffer in sync with _published
  // and the effect of limit enforced.
  _addMatching: function (doc) {
    var self = this;
    var id = doc._id;
    if (self._published.has(id))
      throw Error("tried to add something already published " + id);
    if (self._limit && self._unpublishedBuffer.has(id))
      throw Error("tried to add something already existed in buffer " + id);

    var limit = self._limit;
    var comparator = self._comparator;
    var maxPublished = (limit && self._published.size() > 0) ?
      self._published.get(self._published.maxElementId()) : null;
    var maxBuffered = (limit && self._unpublishedBuffer.size() > 0) ?
      self._unpublishedBuffer.get(self._unpublishedBuffer.maxElementId()) : null;
    // The query is unlimited or didn't publish enough documents yet or the new
    // document would fit into published set pushing the maximum element out,
    // then we need to publish the doc.
    var toPublish = ! limit || self._published.size() < limit ||
                    comparator(doc, maxPublished) < 0;

    // Otherwise we might need to buffer it (only in case of limited query).
    // Buffering is allowed if the buffer is not filled up yet and all matching
    // docs are either in the published set or in the buffer.
    var canAppendToBuffer = !toPublish && self._safeAppendToBuffer &&
                            self._unpublishedBuffer.size() < limit;

    // Or if it is small enough to be safely inserted to the middle or the
    // beginning of the buffer.
    var canInsertIntoBuffer = !toPublish && maxBuffered &&
                              comparator(doc, maxBuffered) <= 0;

    var toBuffer = canAppendToBuffer || canInsertIntoBuffer;

    if (toPublish) {
      self._addPublished(id, doc);
    } else if (toBuffer) {
      self._addBuffered(id, doc);
    } else {
      // dropping it and not saving to the cache
      self._safeAppendToBuffer = false;
    }
  },
  // Called when a document leaves the "Matching" results set.
  // Takes responsibility of keeping _unpublishedBuffer in sync with _published
  // and the effect of limit enforced.
  _removeMatching: function (id) {
    var self = this;
    if (! self._published.has(id) && ! self._limit)
      throw Error("tried to remove something matching but not cached " + id);

    if (self._published.has(id)) {
      self._removePublished(id);
    } else if (self._unpublishedBuffer.has(id)) {
      self._removeBuffered(id);
    }
  },
  _handleDoc: function (id, newDoc) {
    var self = this;
    newDoc = _.clone(newDoc);

    var matchesNow = newDoc && self._matcher.documentMatches(newDoc).result;

    var publishedBefore = self._published.has(id);
    var bufferedBefore = self._limit && self._unpublishedBuffer.has(id);
    var cachedBefore = publishedBefore || bufferedBefore;

    if (matchesNow && !cachedBefore) {
      self._addMatching(newDoc);
    } else if (cachedBefore && !matchesNow) {
      self._removeMatching(id);
    } else if (cachedBefore && matchesNow) {
      var oldDoc = self._published.get(id);
      var comparator = self._comparator;
      var minBuffered = self._limit && self._unpublishedBuffer.size() &&
        self._unpublishedBuffer.get(self._unpublishedBuffer.minElementId());

      if (publishedBefore) {
        // Unlimited case where the document stays in published once it matches
        // or the case when we don't have enough matching docs to publish or the
        // changed but matching doc will stay in published anyways.
        // XXX: We rely on the emptiness of buffer. Be sure to maintain the fact
        // that buffer can't be empty if there are matching documents not
        // published. Notably, we don't want to schedule repoll and continue
        // relying on this property.
        var staysInPublished = ! self._limit ||
                               self._unpublishedBuffer.size() === 0 ||
                               comparator(newDoc, minBuffered) <= 0;

        if (staysInPublished) {
          self._changePublished(id, oldDoc, newDoc);
        } else {
          // after the change doc doesn't stay in the published, remove it
          self._removePublished(id);
          // but it can move into buffered now, check it
          var maxBuffered = self._unpublishedBuffer.get(self._unpublishedBuffer.maxElementId());

          var toBuffer = self._safeAppendToBuffer ||
                         (maxBuffered && comparator(newDoc, maxBuffered) <= 0);

          if (toBuffer) {
            self._addBuffered(id, newDoc);
          } else {
            // Throw away from both published set and buffer
            self._safeAppendToBuffer = false;
          }
        }
      } else if (bufferedBefore) {
        oldDoc = self._unpublishedBuffer.get(id);
        // remove the old version manually so we don't trigger the querying
        // immediately
        self._unpublishedBuffer.remove(id);

        var maxPublished = self._published.get(self._published.maxElementId());
        var maxBuffered = self._unpublishedBuffer.size() && self._unpublishedBuffer.get(self._unpublishedBuffer.maxElementId());

        // the buffered doc was updated, it could move to published
        var toPublish = comparator(newDoc, maxPublished) < 0;

        // or stays in buffer even after the change
        var staysInBuffer = (! toPublish && self._safeAppendToBuffer) ||
          (!toPublish && maxBuffered && comparator(newDoc, maxBuffered) <= 0);

        if (toPublish) {
          self._addPublished(id, newDoc);
        } else if (staysInBuffer) {
          // stays in buffer but changes
          self._unpublishedBuffer.set(id, newDoc);
        } else {
          // Throw away from both published set and buffer
          self._safeAppendToBuffer = false;
        }
      } else {
        throw new Error("cachedBefore implies either of publishedBefore or bufferedBefore is true.");
      }
    }
  },
  _fetchModifiedDocuments: function () {
    var self = this;
    self._registerPhaseChange(PHASE.FETCHING);
    // Defer, because nothing called from the oplog entry handler may yield, but
    // fetch() yields.
    Meteor.defer(function () {
      while (!self._stopped && !self._needToFetch.empty()) {
        if (self._phase !== PHASE.FETCHING)
          throw new Error("phase in fetchModifiedDocuments: " + self._phase);

        self._currentlyFetching = self._needToFetch;
        var thisGeneration = ++self._fetchGeneration;
        self._needToFetch = new LocalCollection._IdMap;
        var waiting = 0;
        var anyError = null;
        var fut = new Future;
        // This loop is safe, because _currentlyFetching will not be updated
        // during this loop (in fact, it is never mutated).
        self._currentlyFetching.forEach(function (cacheKey, id) {
          waiting++;
          self._mongoHandle._docFetcher.fetch(
            self._cursorDescription.collectionName, id, cacheKey,
            function (err, doc) {
              if (err) {
                if (!anyError)
                  anyError = err;
              } else if (!self._stopped && self._phase === PHASE.FETCHING
                         && self._fetchGeneration === thisGeneration) {
                // We re-check the generation in case we've had an explicit
                // _pollQuery call which should effectively cancel this round of
                // fetches.  (_pollQuery increments the generation.)
                self._handleDoc(id, doc);
              }
              waiting--;
              // Because fetch() never calls its callback synchronously, this is
              // safe (ie, we won't call fut.return() before the forEach is
              // done).
              if (waiting === 0)
                fut.return();
            });
        });
        fut.wait();
        // XXX do this even if we've switched to PHASE.QUERYING?
        if (anyError)
          throw anyError;
        // Exit now if we've had a _pollQuery call.
        if (self._phase === PHASE.QUERYING)
          return;
        self._currentlyFetching = null;
      }
      self._beSteady();
    });
  },
  _beSteady: function () {
    var self = this;
    self._registerPhaseChange(PHASE.STEADY);
    var writes = self._writesToCommitWhenWeReachSteady;
    self._writesToCommitWhenWeReachSteady = [];
    self._multiplexer.onFlush(function () {
      _.each(writes, function (w) {
        w.committed();
      });
    });
  },
  _handleOplogEntryQuerying: function (op) {
    var self = this;
    self._needToFetch.set(idForOp(op), op.ts.toString());
  },
  _handleOplogEntrySteadyOrFetching: function (op) {
    var self = this;
    var id = idForOp(op);
    // If we're already fetching this one, or about to, we can't optimize; make
    // sure that we fetch it again if necessary.
    if (self._phase === PHASE.FETCHING &&
        ((self._currentlyFetching && self._currentlyFetching.has(id)) ||
         self._needToFetch.has(id))) {
      self._needToFetch.set(id, op.ts.toString());
      return;
    }

    if (op.op === 'd') {
      if (self._published.has(id) || (self._limit && self._unpublishedBuffer.has(id)))
        self._removeMatching(id);
    } else if (op.op === 'i') {
      if (self._published.has(id))
        throw new Error("insert found for already-existing ID in published");
      if (self._unpublishedBuffer && self._unpublishedBuffer.has(id))
        throw new Error("insert found for already-existing ID in buffer");

      // XXX what if selector yields?  for now it can't but later it could have
      // $where
      if (self._matcher.documentMatches(op.o).result)
        self._addMatching(op.o);
    } else if (op.op === 'u') {
      // Is this a modifier ($set/$unset, which may require us to poll the
      // database to figure out if the whole document matches the selector) or a
      // replacement (in which case we can just directly re-evaluate the
      // selector)?
      var isReplace = !_.has(op.o, '$set') && !_.has(op.o, '$unset');
      // If this modifier modifies something inside an EJSON custom type (ie,
      // anything with EJSON$), then we can't try to use
      // LocalCollection._modify, since that just mutates the EJSON encoding,
      // not the actual object.
      var canDirectlyModifyDoc =
            !isReplace && modifierCanBeDirectlyApplied(op.o);

      var publishedBefore = self._published.has(id);
      var bufferedBefore = self._limit && self._unpublishedBuffer.has(id);

      if (isReplace) {
        self._handleDoc(id, _.extend({_id: id}, op.o));
      } else if ((publishedBefore || bufferedBefore) && canDirectlyModifyDoc) {
        // Oh great, we actually know what the document is, so we can apply
        // this directly.
        var newDoc = self._published.has(id) ?
          self._published.get(id) :
          self._unpublishedBuffer.get(id);
        newDoc = EJSON.clone(newDoc);

        newDoc._id = id;
        LocalCollection._modify(newDoc, op.o);
        self._handleDoc(id, self._sharedProjectionFn(newDoc));
      } else if (!canDirectlyModifyDoc ||
                 self._matcher.canBecomeTrueByModifier(op.o)) {
        self._needToFetch.set(id, op.ts.toString());
        if (self._phase === PHASE.STEADY)
          self._fetchModifiedDocuments();
      }
    } else {
      throw Error("XXX SURPRISING OPERATION: " + op);
    }
  },
  _runInitialQuery: function () {
    var self = this;
    if (self._stopped)
      throw new Error("oplog stopped surprisingly early");

    // Query 2x documents as the half excluded from the original query will go
    // into unpublished buffer to reduce additional Mongo lookups in cases when
    // documents are removed from the published set and need a replacement.
    // XXX needs more thought on non-zero skip
    // XXX "2" here is a "magic number"
    var initialCursor = self._cursorForQuery({ limit: self._limit * 2 });
    var fetchedDocsCount = 0;
    initialCursor.forEach(function (initialDoc) {
      self._addMatching(initialDoc);
      fetchedDocsCount++;
    });

    self._safeAppendToBuffer = fetchedDocsCount < self._limit * 2;

    if (self._stopped)
      throw new Error("oplog stopped quite early");
    // Allow observeChanges calls to return. (After this, it's possible for
    // stop() to be called.)
    self._multiplexer.ready();

    self._doneQuerying();
  },

  // In various circumstances, we may just want to stop processing the oplog and
  // re-run the initial query, just as if we were a PollingObserveDriver.
  //
  // This function may not block, because it is called from an oplog entry
  // handler.
  //
  // XXX We should call this when we detect that we've been in FETCHING for "too
  // long".
  //
  // XXX We should call this when we detect Mongo failover (since that might
  // mean that some of the oplog entries we have processed have been rolled
  // back). The Node Mongo driver is in the middle of a bunch of huge
  // refactorings, including the way that it notifies you when primary
  // changes. Will put off implementing this until driver 1.4 is out.
  _pollQuery: function () {
    var self = this;

    if (self._stopped)
      return;

    // Yay, we get to forget about all the things we thought we had to fetch.
    self._needToFetch = new LocalCollection._IdMap;
    self._currentlyFetching = null;
    ++self._fetchGeneration;  // ignore any in-flight fetches
    self._registerPhaseChange(PHASE.QUERYING);

    // Defer so that we don't block.
    Meteor.defer(function () {
      // subtle note: _published does not contain _id fields, but newResults
      // does
      var newResults = new LocalCollection._IdMap;
      var newBuffer = new LocalCollection._IdMap;
      // XXX 2 is a "magic number" meaning there is an extra chunk of docs for
      // buffer if such is needed.
      var cursor = self._cursorForQuery({ limit: self._limit * 2 });
      cursor.forEach(function (doc, i) {
        if (!self._limit || i < self._limit)
          newResults.set(doc._id, doc);
        else
          newBuffer.set(doc._id, doc);
      });

      self._publishNewResults(newResults, newBuffer);
      self._doneQuerying();
    });
  },

  // Transitions to QUERYING and runs another query, or (if already in QUERYING)
  // ensures that we will query again later.
  //
  // This function may not block, because it is called from an oplog entry
  // handler.
  _needToPollQuery: function () {
    var self = this;
    if (self._stopped)
      return;

    // If we're not already in the middle of a query, we can query now (possibly
    // pausing FETCHING).
    if (self._phase !== PHASE.QUERYING) {
      self._pollQuery();
      return;
    }

    // We're currently in QUERYING. Set a flag to ensure that we run another
    // query when we're done.
    self._requeryWhenDoneThisQuery = true;
  },

  _doneQuerying: function () {
    var self = this;

    if (self._stopped)
      return;
    self._mongoHandle._oplogHandle.waitUntilCaughtUp();

    if (self._stopped)
      return;
    if (self._phase !== PHASE.QUERYING)
      throw Error("Phase unexpectedly " + self._phase);

    if (self._requeryWhenDoneThisQuery) {
      self._requeryWhenDoneThisQuery = false;
      self._pollQuery();
    } else if (self._needToFetch.empty()) {
      self._beSteady();
    } else {
      self._fetchModifiedDocuments();
    }
  },

  _cursorForQuery: function (optionsOverwrite) {
    var self = this;

    // The query we run is almost the same as the cursor we are observing, with
    // a few changes. We need to read all the fields that are relevant to the
    // selector, not just the fields we are going to publish (that's the
    // "shared" projection). And we don't want to apply any transform in the
    // cursor, because observeChanges shouldn't use the transform.
    var options = _.clone(self._cursorDescription.options);

    // Allow the caller to modify the options. Useful to specify different skip
    // and limit values.
    _.extend(options, optionsOverwrite);

    options.fields = self._sharedProjection;
    delete options.transform;
    // We are NOT deep cloning fields or selector here, which should be OK.
    var description = new CursorDescription(
      self._cursorDescription.collectionName,
      self._cursorDescription.selector,
      options);
    return new Cursor(self._mongoHandle, description);
  },


  // Replace self._published with newResults (both are IdMaps), invoking observe
  // callbacks on the multiplexer.
  // Replace self._unpublishedBuffer with newBuffer.
  //
  // XXX This is very similar to LocalCollection._diffQueryUnorderedChanges. We
  // should really: (a) Unify IdMap and OrderedDict into Unordered/OrderedDict (b)
  // Rewrite diff.js to use these classes instead of arrays and objects.
  _publishNewResults: function (newResults, newBuffer) {
    var self = this;

    // If the query is limited and there is a buffer, shut down so it doesn't
    // stay in a way.
    if (self._limit) {
      self._unpublishedBuffer.clear();
    }

    // First remove anything that's gone. Be careful not to modify
    // self._published while iterating over it.
    var idsToRemove = [];
    self._published.forEach(function (doc, id) {
      if (!newResults.has(id))
        idsToRemove.push(id);
    });
    _.each(idsToRemove, function (id) {
      self._removePublished(id);
    });

    // Now do adds and changes.
    // If self has a buffer and limit, the new fetched result will be
    // limited correctly as the query has sort specifier.
    newResults.forEach(function (doc, id) {
      self._handleDoc(id, doc);
    });

    // Sanity-check that everything we tried to put into _published ended up
    // there.
    // XXX if this is slow, remove it later
    if (self._published.size() !== newResults.size()) {
      throw Error("failed to copy newResults into _published!");
    }
    self._published.forEach(function (doc, id) {
      if (!newResults.has(id))
        throw Error("_published has a doc that newResults doesn't; " + id);
    });

    // Finally, replace the buffer
    newBuffer.forEach(function (doc, id) {
      self._addBuffered(id, doc);
    });

    self._safeAppendToBuffer = newBuffer.size() < self._limit;
  },

  // This stop function is invoked from the onStop of the ObserveMultiplexer, so
  // it shouldn't actually be possible to call it until the multiplexer is
  // ready.
  stop: function () {
    var self = this;
    if (self._stopped)
      return;
    self._stopped = true;
    _.each(self._stopHandles, function (handle) {
      handle.stop();
    });

    // Note: we *don't* use multiplexer.onFlush here because this stop
    // callback is actually invoked by the multiplexer itself when it has
    // determined that there are no handles left. So nothing is actually going
    // to get flushed (and it's probably not valid to call methods on the
    // dying multiplexer).
    _.each(self._writesToCommitWhenWeReachSteady, function (w) {
      w.committed();
    });
    self._writesToCommitWhenWeReachSteady = null;

    // Proactively drop references to potentially big things.
    self._published = null;
    self._unpublishedBuffer = null;
    self._needToFetch = null;
    self._currentlyFetching = null;
    self._oplogEntryHandle = null;
    self._listenersHandle = null;

    Package.facts && Package.facts.Facts.incrementServerFact(
      "mongo-livedata", "observe-drivers-oplog", -1);
  },

  _registerPhaseChange: function (phase) {
    var self = this;
    var now = new Date;

    if (self._phase) {
      var timeDiff = now - self._phaseStartTime;
      Package.facts && Package.facts.Facts.incrementServerFact(
        "mongo-livedata", "time-spent-in-" + self._phase + "-phase", timeDiff);
    }

    self._phase = phase;
    self._phaseStartTime = now;
  }
});

// Does our oplog tailing code support this cursor? For now, we are being very
// conservative and allowing only simple queries with simple options.
// (This is a "static method".)
OplogObserveDriver.cursorSupported = function (cursorDescription, matcher) {
  // First, check the options.
  var options = cursorDescription.options;

  // Did the user say no explicitly?
  if (options._disableOplog)
    return false;

  // skip is not supported: to support it we would need to keep track of all
  // "skipped" documents or at least their ids.
  // limit w/o a sort specifier is not supported: current implementation needs a
  // deterministic way to order documents.
  if (options.skip || (options.limit && !options.sort)) return false;

  // If a fields projection option is given check if it is supported by
  // minimongo (some operators are not supported).
  if (options.fields) {
    try {
      LocalCollection._checkSupportedProjection(options.fields);
    } catch (e) {
      if (e.name === "MinimongoError")
        return false;
      else
        throw e;
    }
  }

  // We don't allow the following selectors:
  //   - $where (not confident that we provide the same JS environment
  //             as Mongo, and can yield!)
  //   - $near (has "interesting" properties in MongoDB, like the possibility
  //            of returning an ID multiple times, though even polling maybe
  //            have a bug there)
  //           XXX: once we support it, we would need to think more on how we
  //           initialize the comparators when we create the driver.
  return !matcher.hasWhere() && !matcher.hasGeoQuery();
};

var modifierCanBeDirectlyApplied = function (modifier) {
  return _.all(modifier, function (fields, operation) {
    return _.all(fields, function (value, field) {
      return !/EJSON\$/.test(field);
    });
  });
};

MongoTest.OplogObserveDriver = OplogObserveDriver;
