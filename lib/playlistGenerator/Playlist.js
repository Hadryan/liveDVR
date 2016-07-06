/*
 *   vod packager playlist implementation.
 *   for details see https://github.com/kaltura/nginx-vod-module
 * */

var    _ = require('underscore');
var util = require('util');
var playlistUtils = require('./playlistGen-utils');
var PlaylistItem = require('./PlaylistItem');
var BroadcastEventEmitter = require('./BroadcastEventEmitter');
var MixFilterClip = require('./MixFilterClip');
var Sequence = require('./Sequence');
var TimestampList = require('./TimestampList');
var GapPatcher = require('./GapPatcher');
var loggerModule = require('../../common/logger');
var ValueHolder = require('./ValueHolder');
var TimeRange = playlistUtils.TimeRange;
var path = require('path');

/*
*   Playlist class.
*   implements playlist manifest with metadata required by vod packager to correctly and consistently
*   calculate media playlists and generate media chunks
*   unlike m3u it unifies both playlist and chunklist features.
*
*   properties:
*
*   playlistType :    (vod|live) type of manifest
*   discontinuity : (bool) mode at which packager relies on different heuristics to calculate playlist and media
*   segmentBaseTime : (absolute time ms)  used when discontinuity = false. playlist session start time, may span multiple restarts
*   presentationEndTime : (int) expiry end time (UTC, milliseconds) after which packager is allowed to insert end of stream indicator
*   sequences : (collection of Clip) flavor collection containing MixFilterClip objects
*   durations:  (collection of int) total clip durations; actually it's always 1 long since we use MixFilterClip. along with firstClipTime describes playlist window.
* */
function Playlist(loggerInfo, serializationCtx) {

    this.loggerInfo = loggerInfo + '[p-' + Playlist.prototype.playerId++ + ']' ;
    this.logger = loggerModule.getLogger("Playlist", this.loggerInfo);
    this.gaps = new GapPatcher(this.logger,this);

    this.logger.info("c-tor");

    PlaylistItem.prototype.constructor.call(this, this.logger, this,serializationCtx);

    var inner = this.inner;
    if(!Object.keys(inner).length) {
        inner.durations = [];
        inner.sequences = [];
        inner.playlistType = 'live';
        // segmentBaseTime is readonly, references some arbitrarily picked point in time, namely Sat, 01 Jan 2000 00:00:00 GMT
        // segmentBaseTime is shared by all playlists so that seamless failover may work
        inner.segmentBaseTime = 946684800000;
        inner.discontinuity = true;
        inner.clipTimes = [];
     }
}


util.inherits(Playlist,PlaylistItem);

Playlist.prototype.playerId = 1;

Object.defineProperty(Playlist.prototype , "totalDuration", {
    get: function get_totalDuration() {
        return playlistUtils.sum(this.inner.durations);
    }
});

var createSequence = function(flavor,seq){
    var that = this;

    var newSeq = new Sequence(that.loggerInfo, that, seq, flavor);
    newSeq.addListener(that);
    return newSeq;
};

// lookup flavor sequence and return last clip to append a chunk to
Playlist.prototype.getSequenceForFlavor = function (flavor) {
    var that = this;

    if(flavor === undefined){
        that.logger.warn("Flavor [%s] is undefined. Cannot retrieve sequence for it", flavor);
        return;
    }

    // flavor can be any identifier -> map to index in array of sequences
    var sequence = _.find(that.inner.sequences,function(seq){
        return seq.inner.id == flavor;
    });
    if(sequence === undefined){
        that.logger.info("Add sequence for flavor [%s]", flavor);
        sequence = createSequence.call(that,flavor)
        that.inner.sequences.push(sequence);
    }
    return sequence;
};

var IsNumber = function(n){
    if(typeof n === 'number'){
        return true;
    }
    if(n instanceof ValueHolder && typeof n.value === 'number'){
        return true;
    }
    return false;
};

// PlaylistItem override. test for object state validity
Playlist.prototype.doValidate = function playlist_doValidate(opts) {
    var that = this;

    if( (typeof that.inner.playlistType !== 'string') || ['live','vod'].indexOf(that.inner.playlistType) < 0){
        that.logger.warn("Invalid that.inner.playlistType %s", that.inner.playlistType);
        return false;
    }

    if( !IsNumber(that.inner.segmentBaseTime)){
        that.logger.warn("Invalid that.inner.segmentBaseTime type %s", that.inner.segmentBaseTime);
        return false;
    }

    if( !Array.isArray(that.inner.durations) ){
        that.logger.warn("!that.inner.durations || typeof that.inner.durations !== 'Array'");
        return false;
    }

    if( !_.every(that.inner.durations,function(d){
            return d >= 0;
        })  )  {
        that.logger.warn("that.inner.duration < 0");
        return false;
    }

    if( !Array.isArray(that.inner.sequences)   ) {
        that.logger.warn("!that.inner.sequences || typeof that.inner.sequences !== 'Array'");
        return false;
    }

    if( !_.every( that.inner.sequences, function(seq) {
        if( !_.isArray(seq.clips) ) {
            that.logger.warn("!seq.clips instanceof Array ");
            return false;
        }
        if(that.inner.durations.length !== seq.clips.length){
            that.logger.warn("that.inner.durations.length !== seq.clips.length");
            return false;
        }
        if( seq.doValidate && !seq.doValidate(opts) ){
            return false;
        }
        return true;
    })) {
        return false;
    }

    // true for single flavor only
    if( that.inner.sequences.length === 1) {
        if (!_.every(that.inner.sequences[0].clips, function (clip, index) {
                var clipD = clip.getTotalDuration(),
                    overallD = that.inner.durations[index];
                if (overallD - clipD > playlistUtils.playlistConfig.timestampToleranceMs) {
                    that.logger.warn("Clip [%d] internal duration = %d != overall duration = %d", index, overallD, clipD);
                    return false;
                }
                return true;
            })) {
            return false;
        }
    }

    if(that.inner.clipTimes.length && that.inner.clipTimes[0] <  that.inner.segmentBaseTime)  {
        that.logger.warn("that.inner.clipTimes[0] <  that.inner.segmentBaseTime");
        return false;
    }

    if( !that.gaps.doValidate() ){
        return false;
    }

    if( !Array.isArray(that.inner.clipTimes)   ) {
        that.logger.warn("!Array.isArray(that.inner.clipTimes)");
        return false;
    }

    if( that.inner.clipTimes.length !==  that.inner.durations.length  ) {
        that.logger.warn("that.inner.clipTime.length !==  that.inner.durations.length");
        return false;
    }

    if(_.some(that.inner.clipTimes, function(clipTime,index){
            if( index > 0 ){
                return that.inner.clipTimes[index-1] + that.inner.durations[index-1] > that.inner.clipTimes[index];
            }
            return false;
        })) {
        that.logger.warn("that.inner.clipTimes[idx]-that.inner.durations[idx-1] >= that.inner.clipTimes[idx-1]");
        return false;
    }

    if( that.playListLimits && that.playListLimits.manifestTimeWindowInMsec &&
        1.5 * that.playListLimits.manifestTimeWindowInMsec < that.totalDuration ){
        that.logger.warn("that.playListLimits.manifestTimeWindowInMsec <  that.totalDuration. (%d < %d)",
            that.playListLimits.manifestTimeWindowInMsec , that.totalDuration );
        return false;
    }

    if(that.inner.sequences.length > 1 && that.inner.clipTimes.length > 0){
        _.each(that.inner.clipTimes, function(ct,index){

            var srcInfos =_.reduce(that.inner.sequences, function(val,seq){
                return val.concat(seq.clips[index].inner.sources);
            },[]);

            var videos = _.filter(srcInfos,function(i){
                return i.isVideo;
            }), audios = _.filter(srcInfos,function(i){
                return !i.isVideo;
            });



            if( _.any(videos,function(v){
                    return v.inner.offset < 0;
                })) {
                that.logger.warn("v.offset < 0");
                return false;
            }

            if( _.any(audios,function(a){
                    return a.inner.offset < 0;
                })) {
                that.logger.warn("v.offset < 0;");
                return false;
            }

            // all but injest(s)
            if(_.any(videos.slice(1),function(a,index){
                    return videos[1].inner.offset !== a.inner.offset;
                }) ){
                that.logger.warn("videos offsets! %j",util.inspect(_.map(videos,function(a){
                    return a.inner.offset;
                })));
                return false;
            }

            //check if all audios match incl. injest
            if(_.any(audios,function(a,index){
                    return audios[0].inner.offset !== a.inner.offset;
                }) ){
                that.logger.warn("audio offsets! %j",util.inspect(_.map(audios,function(a){
                    return a.inner.offset;
                })));
                return false;
            }
        });

    }

    return PlaylistItem.prototype.doValidate.apply(that,arguments);
};

var rangeOverlap = function(dtsRange2){
    return this.min < dtsRange2.max && this.max > dtsRange2.min;
};

var calcClipStartTimeAndDuration = function(index){
    var that = this;

    var retVal = new TimeRange();

    // determine dts range

    // step # 1: fill out all clip ranges
    var ranges = _.map(that.inner.sequences,function(seq){
        if(seq.clips.length > index) {
            return seq.clips[index].getDTSRange();
        }
        return null;
    });

    ranges = _.compact(ranges);

    // step # 2: find sequences that have overlapping regions with other clip sequences

    var result = [];
    // look for disjoint sets. pick up the latest
    while(_.size(ranges) > 0) {
        var curRange = ranges.shift();
        if(_.size(ranges) > 0) {
            var affine = _.filter(ranges, rangeOverlap, curRange);
            _.each(affine, function (r) {
                curRange.mergeWith(r);
            });
            ranges = _.difference(ranges, affine);
        }
        result.push(curRange);
    }

    if(result.length) {
        retVal = _.max(result,function(r){return r.max;});
    }

    if(retVal.valid) {

        that.inner.durations[index] = retVal.max - retVal.min;

        if( that.inner.clipTimes[index].value != retVal.min) {
            that.inner.clipTimes[index].value = retVal.min;
            that.logger.info("Recalculate Offsets And Duration(%d). Set clipTime: %s (%d). duration: %d",
                index,
                new Date(that.inner.clipTimes[index]),
                that.inner.clipTimes[index],
                that.inner.durations[index]);

            // special case for first clip
            if (index === 0) {
               that.emit(playlistUtils.ClipEvents.base_time_changed,  that.inner.clipTimes[index].value);
            }
        }
    }
    return retVal;
};

var invalidRangeError = new Error('invalid time range');

// calculate firstClipTime, update segmentBaseTime (if needed) and sequences clips offsets
Playlist.prototype.recalculateOffsetsAndDuration = function recalculateOffsetsAndDuration (){
    var that = this;

    that.logger.debug('recalculateOffsetsAndDuration');

    that.gaps.update();

    var retVal = new TimeRange();

    var minMaxInfos = _.map(that.inner.durations, function (d, index){
        this.inner.durations[index] = 0;
        return calcClipStartTimeAndDuration.call(this,index);
    },that).filter(function(minMax){
        return minMax.valid;
    });

    if(minMaxInfos.length) {
        retVal.min = minMaxInfos.first.min;
        retVal.max = minMaxInfos.last.max;
    }

    return retVal;

};

// PlaylistItem override used during serialization
Playlist.prototype.onUnserialize = function () {
    var that = this;

    that.inner.clipTimes = _.map(that.inner.clipTimes,function(ct){
        return new ValueHolder(ct);
    });
    that.inner.sequences = _.map(that.inner.sequences,function(seq){
        //flavor will be derived from seq object
        return createSequence.call(that,null,seq);
    });

    that.recalculateOffsetsAndDuration();
};

//BroadcastEventEmitter overrides
Playlist.prototype.addListener = function(arg0){
    var that = this;

    var args = arguments;

    BroadcastEventEmitter.prototype.addListener.apply(this,args);
    // do not allow subscribing to named groups except this object
    if (typeof arg0 !== 'string') {
        _.each(that.inner.sequences, function (seq) {
            seq.addListener.apply(seq, args);
        });
    }
};

Playlist.prototype.removeListener = function(listener){
    BroadcastEventEmitter.prototype.removeListener.call(this,listener);
    _.each(that.inner.sequences,function (seq) {
        seq.removeListener(listener);
    });
};

// JSON serialization from disk/etc
Playlist.prototype.serializeFrom = function (playlistJSON,loggerInfo,cbDone){
    var playlist = undefined;
    try {
        playlist = JSON.parse(playlistJSON);
        playlist = new Playlist(loggerInfo,playlist);
    } catch (err) {
        loggerModule.getLogger("Playlist.serializeFrom", loggerInfo + " ").warn('Unable to un-serialize playlist. Data loss is inevitable!');
        if(cbDone){
            playlist = new Playlist(loggerInfo);
        }
    }
    if(cbDone){
        cbDone(playlist);
    }
};

// diagnostics info.

Playlist.prototype.getDiagnostics = function (opts) {
    var that = this,
        clipDuration = (opts && opts.clipDuration) ? opts.clipDuration : 10000;

    that.recalculateOffsetsAndDuration();

    var totalDuration = that.totalDuration;


    // current playlist state:
    // * segmentBaseTime - reference point for segment number calculation
    // * firstClipTime - live window lower bound
    // * we assume {now,segmentBaseTime,firstClipTime} are measured by identical clock (!weak assumption!)
    // * now - (firstClipTime+totalDuration + gapsMsec) = media not yet in the playlist

    /*        |segmentBaseTime   |firstClipTime                |firstClipTime+totalDuration     |now
        ------X------------------X------A-------------A--------X--------------------------------X-----------> t
                                        | gap1        |gap2
                    |<--offset-->|                                   |actual flavor duration    |now
     flavor N   ----X------------X-----------------------------------X--------------------------X-----------> t
    */

    var diag =  {
        unitMs: clipDuration,
        discontinuityMode:  that.inner.discontinuity,
        now:Math.floor((Date.now() - that.inner.segmentBaseTime) / clipDuration),
        window: {},
        windowDurationMs: totalDuration,
        gaps: that.inner.gaps.toHumanReadable(clipDuration)
    };

    if(that.minMax && keys.length > 0) {
        var range = that.minMax,
            min = Math.floor((range.min - that.inner.segmentBaseTime) / clipDuration),
            max = Math.floor((range.max - that.inner.segmentBaseTime) / clipDuration);
        diag.window['P'] = [min,max];

        _.each(that.inner.sequences, function (seq) {
            range = seq.clips[0].getDTSRange();
            min = Math.floor((range.min - that.inner.segmentBaseTime) / clipDuration);
            max = Math.floor((range.max - that.inner.segmentBaseTime) / clipDuration);
            diag.window['' + seq.inner.id + ''] = [min,max];
        });
    }

    if(totalDuration && that.minMax) {
        var overallDuration = Math.max(0,that.minMax.max - that.minMax.min);
        if(overallDuration > totalDuration){
            diag.gapsMsec = overallDuration - totalDuration;
            diag.playbackWindow = that.minMax;
        }
    }
    return diag;
};

// collapse gaps so that playlist don't contain overlapping media and gaps
Playlist.prototype.collapseGap = function(gap) {
    var that = this;
    if(gap.from < gap.to) {
        that.gaps.collapseGap(gap);
    }
};


// used by JSON.sringify
Playlist.prototype.toJSON = function(){
    var that = this;

    if(!that.minMax){
        return PlaylistItem.prototype.toJSON.call(that);
    }

    var obj = _.clone(that.inner);

    obj.sequences = _.filter(obj.sequences,function(seq){
        if(seq.clips.length) {
            var dtsRange = seq.clips[0].getDTSRange();
            return rangeOverlap.call(that.minMax,dtsRange);
        }
    });

    that.logger.debug("toJSON: %d valid sequences", obj.sequences.length);

    return obj;
};

// return clip approprate for appending a newly inserted chunk
Playlist.prototype.insertChunk = function (fileInfo) {
    var that = this;

    var seq = that.getSequenceForFlavor(fileInfo.flavor);

    var chunkName = path.basename(fileInfo.path);

    if(chunkName && !seq.checkFileExists(chunkName)) {

        if (seq.clips.length === 0) {
            seq.createAndAppendNewClip();
        }

        seq.clips.last.insert(fileInfo);

        return true;
    }
    return false;
};

Playlist.prototype.checkAddClipTime = function(seq){
    var that = this;

    while(seq.clips.length >= that.inner.clipTimes.length){
        that.logger.info("checkAddClipTime. sequence %j length=%j append new clip",
            seq.inner.id,
            seq.clips.length);
        that.inner.clipTimes.push(new ValueHolder(0));
    }
    while(seq.clips.length >= that.inner.durations.length){
        that.inner.durations.push(0);
    }
    return that.inner.clipTimes.last;
};

Playlist.prototype.isModified = function(){
    var that = this;

    var playlist = that.inner;

    if (playlist.durations.length > 0) {
        var minMax = that.recalculateOffsetsAndDuration();

        if( minMax == that.minMax ){
            return false;
        }

        // only update manifest if all downloaders have contributed to max
        if ( that.minMax && minMax.max === that.minMax.max ) {
            return false;
        }

        that.collectObsoleteClips();

        minMax = that.recalculateOffsetsAndDuration();

        that.logger.info("playlist modified: %j vs %j",minMax.max,that.minMax ? that.minMax.max : 0);

        that.minMax = minMax;

        return true;
    }
    return false;
};

Playlist.prototype.collectObsoleteClips = function () {
    var that = this;

    while (that.inner.durations.length) {

        var seqs = _.filter(that.inner.sequences, function (seq) {
            return seq.clips.length > 0;
        });

        if (_.every(seqs, function (seq) {
                return seq.inner.clips.first.isEmpty();
            })) {
            _.each(seqs, function (seq) {

                that.logger.warn("collectObsoleteClips pop clip off seq=(%j) clips_count=%j", seq.inner.id, seq.clips.length);

                seq.inner.clips.shift();

            });

            that.inner.clipTimes.shift();
            that.inner.durations.shift();

            playlistUtils.dbgAssert(that.inner.durations.length === that.inner.clipTimes.length);

            _.each(seqs,function(seq){
                playlistUtils.dbgAssert(seq.inner.clips.length === that.inner.clipTimes.length);
            });

        } else {
            break;
        }
    }
};

Playlist.prototype.handleEvent = function (type,arg) {
    var that = this;

    switch(type) {
        case playlistUtils.ClipEvents.item_disposed:
            that.removeListener(arg);
        default:
            that.emit.apply(that,arguments);
    }

};

Playlist.prototype.checkFileExists = function(fileName){
    var that = this;

    return _.any(that.inner.sequences,function(seq){
        return seq.checkFileExists(fileName);
    });
};

module.exports = Playlist;