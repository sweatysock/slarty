// UI behaviour setup
// 
$(document).ready(function () {
	$("#startBtn").click(function () {
		$(this).hide();
		startTalking();
	});
});


//Global variables
const SampleRate = 16000; 	// Global sample rate used for all audio
const PacketSize = 500; 	// Global packet size (bytes) to/from server
var chunkSize; 			// Samples needed to send 500 samples at SampleRate
var soundcardSampleRate; 	// Set this value when we get our AudioContext
var audenceNode; 		// Our audio processing node

// First task is to connect to the server. Without this we are going nowhere.
var socketIO = io();
var socketConnected = false; 	// true if client is connected



socketIO.on('connect', function (socket) {
	console.log('socket connected!');
	socketConnected = true;
	// Say hi to the server letting it know we consider it upstream 
	socketIO.emit("upstreamHi");

	// Data coming down from upstream server: Group mix plus separate member audios
	socketIO.on('d', function (data) { 
		let resampledData = []; 		// Final output audio array
  		let finalMix = data["a"];		// Mix from server
  		let clientBuffers = data["c"];		// All client audio that is mix
  		let gain = data["g"];			// Gain needed for subtracting
		let myID = socketIO.id;	// myID = my buffer
		let b, buffer = null;			// Find my buffer in clientBuffers
//		clientBuffers.forEach( b => { if ( b.clientID == myID ) buffer = b; });
		// subtract my gain adjusted audio buffer from the finalMix to stop feedback
//		if ( buffer != null ) for ( i=0; i < buffer.audio.length; i++ )
//			finalMix[i] = finalMix[i] - buffer.audio[i] * gain;
		// Mix group member, zone and stadium audio streams according to mix table
		
		// Expand the audio data up to the soundcard sample rate
		resampledData = resample(finalMix, SampleRate, soundcardSampleRate, chunkSize);
		if (audenceNode != null)
			audenceNode.port.postMessage({
				"audio": resampledData,
			});
		// Update UI with audio data now
	});

	socketIO.on('clients', function (cnt) {
		console.log("CLIENT data from server");
		$("#clients").text(cnt);
		// Get client position update.
		// Update UI and audio mix table with client data updated
		// Send audio mix table to worker
	});
});

socketIO.on('disconnect', function () {
	console.log('socket disconnected!');
	socketConnected = false;
});



// Need function to receive UI position updates in order to rebuild audio mix table
// and to send the new UI position out to the other clients


// Audio setup when user hits start talking button
var counter =0;
function startTalking() { 				// Get mic access and connect it up
	if (navigator.mediaDevices) {
		console.log('getUserMedia supported.');
		navigator.getUserMedia = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia);
		navigator.mediaDevices.getUserMedia ({audio:{latency:0.4,echoCancellation:true,autoGainControl:false,noiseSuppression:false} , video: false})
		.then(function(stream) {
			// First get an audio context
			var context = new (window.AudioContext || window.webkitAudioContext)();
			soundcardSampleRate = context.sampleRate; //Sample rate from the soundcard 
			// How many samples are needed from this soundcard to fill a packet
			chunkSize = Math.round(soundcardSampleRate * PacketSize / SampleRate);
			// Next create a MediaStreamAudioSourceNode = Mic input = source
			var source = context.createMediaStreamSource(stream);
			let supported = navigator.mediaDevices.getSupportedConstraints();
			// And then we need a worklet to inject our audio into the browser audio stream
			context.audioWorklet.addModule('js/audenceWorker.js').then(() => {
				audenceNode = new AudioWorkletNode(
					context, 'audence-processor', {parameterData:{ size: chunkSize } }
				);
				// connect source to audenceNode to destination
				source.connect(audenceNode);
				audenceNode.connect(context.destination);
				// When audio comes from the user's mic it reaches us here
				audenceNode.port.onmessage = (e) => {
					if (socketConnected) { // Only send audio if we are connected
						var audioData = e.data.audio;
						// Raw data needs to be down sampled before sending to server
						let Data = resample(audioData, soundcardSampleRate, SampleRate, chunkSize);
						// Sending audio UP to our upstream server
						socketIO.emit("u", {
								"audio": Data,
						});
						// Update UI now
					}
				}
			});
		})
		.catch(function(err) {
			console.log('The following getUserMedia error occured: ' + err);
		});
	} else {
		alert('getUserMedia not supported on your browser!');
	}
}







/*---------------------------------------------------
		--- Dont send data if there is only silence ---
---------------------------------------------------*/

var currntPass = 0; // Start off with sound muted until noise made
//Trim the audio singal if under a given value
function gainGuard(data, minGain) {
  var vaildData = false;
  for (var i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) < minGain) {
      if (currntPass == 0) {
        data[i] = 0; // Drop to zero if low
      }
      else {
        vaildData = true;
        currntPass--;
      }
    }
    else {
      vaildData = true;
      currntPass = 10000; //let 4000 samples pass after the last sample OVER minGain
    }
  }
  if (vaildData)
    return data;
  else {
    resapelBuffer = []; //Remove old audio from buffer because there should not be a silence at the begin of the next voice
    return null;
  }
}
// MARK CHANGES START NOW
/*---------------------------------------------------
		--- CHANGE SAMPLERATE FUNCTIONS --- (with simple interpolation)
---------------------------------------------------*/
function resample(inDataArrayBuffer, inSampleRate, outSampleRate, outChunkSize) {
  if (inSampleRate == outSampleRate) return inDataArrayBuffer;
  if (inSampleRate > outSampleRate) {
    return downSample(inSampleRate, outSampleRate, inDataArrayBuffer);
  } else {
    return upSample(inSampleRate, outSampleRate, outChunkSize, inDataArrayBuffer);
  }
}

function downSample(fromSampleRate, toSampleRate, buffer) {
  let outLength = buffer.length / (fromSampleRate / toSampleRate);
  let outBuffer = [];
  let s = Smooth(buffer, { scaleTo: outLength, method: 'cubic', clip: "clamp" });

  for (let i = 0; i < outLength; i++) {
    outBuffer.push(s(i));
  }
  return outBuffer;
}

function upSample(fromSampleRate, toSampleRate, chunkSize, buffer) {
  let sampleBuffer = [];
  let outLength = buffer.length / (fromSampleRate / toSampleRate);
  let s = buffer.length > 0 ? Smooth(buffer, { scaleTo: outLength, method: 'cubic', clip: "clamp" }) : [];

  for (let i = 0; i < chunkSize; i++) {
    sampleBuffer.push(s(i));
  }
  return sampleBuffer;
}

/*---------------------------------------------------
		--- USE THE WHOLE CHANNEL SPECTRUM 0-1 ---
---------------------------------------------------*/

function maxSignal(buffer) {
  var max = 0;
  if (buffer) {
    for (var i = 0; i < buffer.length; i++) {
      if (max < Math.abs(buffer[i]))
        max = Math.abs(buffer[i]);
    }
  }
  if (max === 0)
    return buffer;

  var p = (1 / max);
  p = Math.floor(p * 100) / 100;
  if (p > 2.55)
    p = 2.55;

  var ret = [];
  for (var i = 0; i < buffer.length; i++) {
    ret.push(buffer[i] * p);
  }
  return { "ret": ret, "p": p };
}

function lowSignal(buffer, p) {
  var ret = [];
  for (var i = 0; i < buffer.length; i++) {
    ret.push(buffer[i] / p);
  }
  return ret;
}

/*---------------------------------------------------
		--- CHANGE BITRATE FUNCTIONS ---
---------------------------------------------------*/

//Put flt32Array in get Uint16Array Out
function mapFloat32ToUInt16Array(flt32) {
  var uint16Array = new Uint16Array(flt32.length);
  for (var i = 0; i < flt32.length; i++) {
    uint16Array[i] = (flt32[i] + 1) * 32767.5;
  }
  return uint16Array;
}

//Put Uint16Array in get flt32Array Out
function mapUint16ToFloat32Array(uin16) {
  var flt32Array = new Float32Array(uin16.length);
  for (var i = 0; i < uin16.length; i++) {
    flt32Array[i] = uin16[i] * 0.000030518043793392844 - 1;
  }
  return flt32Array;
}

//Put Uint8Array in get flt32Array Out
function mapUint8ToFloat32Array(uin8) {
  var flt32Array = new Float32Array(uin8.length);
  for (var i = 0; i < uin8.length; i++) {
    flt32Array[i] = uin8[i] * 0.00784313725490196 - 1; // 0.00784313725490196 = 2/255
  }
  return flt32Array;
}

//Put flt32Array in get Uint8Array Out
function mapFloat32ToUInt8Array(flt32) {
  var uint8Array = new Uint8Array(flt32.length);
  for (var i = 0; i < flt32.length; i++) {
    uint8Array[i] = (flt32[i] + 1) * 127.5;
  }
  return uint8Array;
}

//-------------------------------



/*
Smooth.js version 0.1.7

Turn arrays into smooth functions.

Copyright 2012 Spencer Cohen
Licensed under MIT license (see "Smooth.js MIT license.txt")
*/

/*Constants (these are accessible by Smooth.WHATEVER in user space)
*/

(function () {
  var AbstractInterpolator, CubicInterpolator, Enum, LinearInterpolator, NearestInterpolator, PI, SincFilterInterpolator, Smooth, clipClamp, clipMirror, clipPeriodic, defaultConfig, getColumn, getType, isValidNumber, k, makeLanczosWindow, makeScaledFunction, makeSincKernel, normalizeScaleTo, shallowCopy, sin, sinc, v, validateNumber, validateVector,
    __hasProp = Object.prototype.hasOwnProperty,
    __extends = function (child, parent) { for (var key in parent) { if (__hasProp.call(parent, key)) child[key] = parent[key]; } function ctor() { this.constructor = child; } ctor.prototype = parent.prototype; child.prototype = new ctor; child.__super__ = parent.prototype; return child; };

  Enum = {
    /*Interpolation methods
    */
    METHOD_NEAREST: 'nearest',
    METHOD_LINEAR: 'linear',
    METHOD_CUBIC: 'cubic',
    METHOD_LANCZOS: 'lanczos',
    METHOD_SINC: 'sinc',
    /*Input clipping modes
    */
    CLIP_CLAMP: 'clamp',
    CLIP_ZERO: 'zero',
    CLIP_PERIODIC: 'periodic',
    CLIP_MIRROR: 'mirror',
    /* Constants for control over the cubic interpolation tension
    */
    CUBIC_TENSION_DEFAULT: 0,
    CUBIC_TENSION_CATMULL_ROM: 0
  };

  defaultConfig = {
    method: Enum.METHOD_CUBIC,
    cubicTension: Enum.CUBIC_TENSION_DEFAULT,
    clip: Enum.CLIP_CLAMP,
    scaleTo: 0,
    sincFilterSize: 2,
    sincWindow: void 0
  };

  /*Index clipping functions
  */

  clipClamp = function (i, n) {
    return Math.max(0, Math.min(i, n - 1));
  };

  clipPeriodic = function (i, n) {
    i = i % n;
    if (i < 0) i += n;
    return i;
  };

  clipMirror = function (i, n) {
    var period;
    period = 2 * (n - 1);
    i = clipPeriodic(i, period);
    if (i > n - 1) i = period - i;
    return i;
  };

  /*
  Abstract scalar interpolation class which provides common functionality for all interpolators
  
  Subclasses must override interpolate().
  */

  AbstractInterpolator = (function () {

    function AbstractInterpolator(array, config) {
      if (typeof (array.slice) === "undefined")
        this.array = array.subarray(0);
      else
        this.array = array.slice(0);
      this.length = this.array.length;
      if (!(this.clipHelper = {
        clamp: this.clipHelperClamp,
        zero: this.clipHelperZero,
        periodic: this.clipHelperPeriodic,
        mirror: this.clipHelperMirror
      }[config.clip])) {
        throw "Invalid clip: " + config.clip;
      }
    }

    AbstractInterpolator.prototype.getClippedInput = function (i) {
      if ((0 <= i && i < this.length)) {
        return this.array[i];
      } else {
        return this.clipHelper(i);
      }
    };

    AbstractInterpolator.prototype.clipHelperClamp = function (i) {
      return this.array[clipClamp(i, this.length)];
    };

    AbstractInterpolator.prototype.clipHelperZero = function (i) {
      return 0;
    };

    AbstractInterpolator.prototype.clipHelperPeriodic = function (i) {
      return this.array[clipPeriodic(i, this.length)];
    };

    AbstractInterpolator.prototype.clipHelperMirror = function (i) {
      return this.array[clipMirror(i, this.length)];
    };

    AbstractInterpolator.prototype.interpolate = function (t) {
      throw 'Subclasses of AbstractInterpolator must override the interpolate() method.';
    };

    return AbstractInterpolator;

  })();

  NearestInterpolator = (function (_super) {

    __extends(NearestInterpolator, _super);

    function NearestInterpolator() {
      NearestInterpolator.__super__.constructor.apply(this, arguments);
    }

    NearestInterpolator.prototype.interpolate = function (t) {
      return this.getClippedInput(Math.round(t));
    };

    return NearestInterpolator;

  })(AbstractInterpolator);

  LinearInterpolator = (function (_super) {

    __extends(LinearInterpolator, _super);

    function LinearInterpolator() {
      LinearInterpolator.__super__.constructor.apply(this, arguments);
    }

    LinearInterpolator.prototype.interpolate = function (t) {
      var k;
      k = Math.floor(t);
      t -= k;
      return (1 - t) * this.getClippedInput(k) + t * this.getClippedInput(k + 1);
    };

    return LinearInterpolator;

  })(AbstractInterpolator);

  CubicInterpolator = (function (_super) {

    __extends(CubicInterpolator, _super);

    function CubicInterpolator(array, config) {
      this.tangentFactor = 1 - Math.max(0, Math.min(1, config.cubicTension));
      CubicInterpolator.__super__.constructor.apply(this, arguments);
    }

    CubicInterpolator.prototype.getTangent = function (k) {
      return this.tangentFactor * (this.getClippedInput(k + 1) - this.getClippedInput(k - 1)) / 2;
    };

    CubicInterpolator.prototype.interpolate = function (t) {
      var k, m, p, t2, t3;
      k = Math.floor(t);
      m = [this.getTangent(k), this.getTangent(k + 1)];
      p = [this.getClippedInput(k), this.getClippedInput(k + 1)];
      t -= k;
      t2 = t * t;
      t3 = t * t2;
      return (2 * t3 - 3 * t2 + 1) * p[0] + (t3 - 2 * t2 + t) * m[0] + (-2 * t3 + 3 * t2) * p[1] + (t3 - t2) * m[1];
    };

    return CubicInterpolator;

  })(AbstractInterpolator);

  sin = Math.sin, PI = Math.PI;

  sinc = function (x) {
    if (x === 0) {
      return 1;
    } else {
      return sin(PI * x) / (PI * x);
    }
  };

  makeLanczosWindow = function (a) {
    return function (x) {
      return sinc(x / a);
    };
  };

  makeSincKernel = function (window) {
    return function (x) {
      return sinc(x) * window(x);
    };
  };

  SincFilterInterpolator = (function (_super) {

    __extends(SincFilterInterpolator, _super);

    function SincFilterInterpolator(array, config) {
      SincFilterInterpolator.__super__.constructor.apply(this, arguments);
      this.a = config.sincFilterSize;
      if (!config.sincWindow) throw 'No sincWindow provided';
      this.kernel = makeSincKernel(config.sincWindow);
    }

    SincFilterInterpolator.prototype.interpolate = function (t) {
      var k, n, sum, _ref, _ref2;
      k = Math.floor(t);
      sum = 0;
      for (n = _ref = k - this.a + 1, _ref2 = k + this.a; _ref <= _ref2 ? n <= _ref2 : n >= _ref2; _ref <= _ref2 ? n++ : n--) {
        sum += this.kernel(t - n) * this.getClippedInput(n);
      }
      return sum;
    };

    return SincFilterInterpolator;

  })(AbstractInterpolator);

  getColumn = function (arr, i) {
    var row, _i, _len, _results;
    _results = [];
    for (_i = 0, _len = arr.length; _i < _len; _i++) {
      row = arr[_i];
      _results.push(row[i]);
    }
    return _results;
  };

  makeScaledFunction = function (f, baseScale, scaleRange) {
    var scaleFactor, translation;
    if (scaleRange.join === '0,1') {
      return f;
    } else {
      scaleFactor = baseScale / (scaleRange[1] - scaleRange[0]);
      translation = scaleRange[0];
      return function (t) {
        return f(scaleFactor * (t - translation));
      };
    }
  };

  getType = function (x) {
    return Object.prototype.toString.call(x).slice('[object '.length, -1);
  };

  validateNumber = function (n) {
    if (isNaN(n)) throw 'NaN in Smooth() input';
    if (getType(n) !== 'Number') throw 'Non-number in Smooth() input';
    if (!isFinite(n)) throw 'Infinity in Smooth() input';
  };

  validateVector = function (v, dimension) {
    var n, _i, _len;
    if (getType(v) !== 'Array') throw 'Non-vector in Smooth() input';
    if (v.length !== dimension) throw 'Inconsistent dimension in Smooth() input';
    for (_i = 0, _len = v.length; _i < _len; _i++) {
      n = v[_i];
      validateNumber(n);
    }
  };

  isValidNumber = function (n) {
    return (getType(n) === 'Number') && isFinite(n) && !isNaN(n);
  };

  normalizeScaleTo = function (s) {
    var invalidErr;
    invalidErr = "scaleTo param must be number or array of two numbers";
    switch (getType(s)) {
      case 'Number':
        if (!isValidNumber(s)) throw invalidErr;
        s = [0, s];
        break;
      case 'Array':
        if (s.length !== 2) throw invalidErr;
        if (!(isValidNumber(s[0]) && isValidNumber(s[1]))) throw invalidErr;
        break;
      default:
        throw invalidErr;
    }
    return s;
  };

  shallowCopy = function (obj) {
    var copy, k, v;
    copy = {};
    for (k in obj) {
      if (!__hasProp.call(obj, k)) continue;
      v = obj[k];
      copy[k] = v;
    }
    return copy;
  };

  Smooth = function (arr, config) {
    var baseDomainEnd, dimension, i, interpolator, interpolatorClass, interpolators, k, n, properties, smoothFunc, v;
    if (config == null) config = {};
    properties = {};
    config = shallowCopy(config);
    properties.config = shallowCopy(config);
    if (config.scaleTo == null) config.scaleTo = config.period;
    if (config.sincFilterSize == null) {
      config.sincFilterSize = config.lanczosFilterSize;
    }
    for (k in defaultConfig) {
      if (!__hasProp.call(defaultConfig, k)) continue;
      v = defaultConfig[k];
      if (config[k] == null) config[k] = v;
    }
    if (!(interpolatorClass = {
      nearest: NearestInterpolator,
      linear: LinearInterpolator,
      cubic: CubicInterpolator,
      lanczos: SincFilterInterpolator,
      sinc: SincFilterInterpolator
    }[config.method])) {
      throw "Invalid method: " + config.method;
    }
    if (config.method === 'lanczos') {
      config.sincWindow = makeLanczosWindow(config.sincFilterSize);
    }
    if (arr.length < 2) throw 'Array must have at least two elements';
    properties.count = arr.length;
    smoothFunc = (function () {
      var _i, _j, _len, _len2;
      switch (getType(arr[0])) {
        case 'Number':
          properties.dimension = 'scalar';
          if (Smooth.deepValidation) {
            for (_i = 0, _len = arr.length; _i < _len; _i++) {
              n = arr[_i];
              validateNumber(n);
            }
          }
          interpolator = new interpolatorClass(arr, config);
          return function (t) {
            return interpolator.interpolate(t);
          };
        case 'Array':
          properties.dimension = dimension = arr[0].length;
          if (!dimension) throw 'Vectors must be non-empty';
          if (Smooth.deepValidation) {
            for (_j = 0, _len2 = arr.length; _j < _len2; _j++) {
              v = arr[_j];
              validateVector(v, dimension);
            }
          }
          interpolators = (function () {
            var _results;
            _results = [];
            for (i = 0; 0 <= dimension ? i < dimension : i > dimension; 0 <= dimension ? i++ : i--) {
              _results.push(new interpolatorClass(getColumn(arr, i), config));
            }
            return _results;
          })();
          return function (t) {
            var interpolator, _k, _len3, _results;
            _results = [];
            for (_k = 0, _len3 = interpolators.length; _k < _len3; _k++) {
              interpolator = interpolators[_k];
              _results.push(interpolator.interpolate(t));
            }
            return _results;
          };
        default:
          throw "Invalid element type: " + (getType(arr[0]));
      }
    })();
    if (config.clip === 'periodic') {
      baseDomainEnd = arr.length;
    } else {
      baseDomainEnd = arr.length - 1;
    }
    config.scaleTo || (config.scaleTo = baseDomainEnd);
    properties.domain = normalizeScaleTo(config.scaleTo);
    smoothFunc = makeScaledFunction(smoothFunc, baseDomainEnd, properties.domain);
    properties.domain.sort();
    /*copy properties
    */
    for (k in properties) {
      if (!__hasProp.call(properties, k)) continue;
      v = properties[k];
      smoothFunc[k] = v;
    }
    return smoothFunc;
  };

  for (k in Enum) {
    if (!__hasProp.call(Enum, k)) continue;
    v = Enum[k];
    Smooth[k] = v;
  }

  Smooth.deepValidation = false;

  (typeof exports !== "undefined" && exports !== null ? exports : this).Smooth = Smooth;

}).call(this);
