//Global variables
//
const SampleRate = 16000; 						// Global sample rate used for all audio
const PacketSize = 500;							// Server packet size we must conform to
var chunkSize = 1024;							// Audio chunk size. Fixed by js script processor
var soundcardSampleRate = null; 					// Get this from context 
var resampledChunkSize = 0;						// Once resampled the chunks are this size
var socketConnected = false; 						// True when socket is up
var micAccessAllowed = false; 						// Need to get user permission
var spkrBuffer = []; 							// Audio buffer going to speaker
var maxBuffSize = 5000;							// Max audio buffer chunks for playback
var micBuffer = [];							// Buffer mic audio before sending
var muted = false;							// mic mute control
var mixGain = 1;							// Gain applied to mix
var micGain = 1;							// Gain applied to microphone input
var myChannel = -1;							// The server assigns us an audio channel
var myName = "";							// Name assigned to my audio channel




// Network code
//
var socketIO = io();
socketIO.on('connect', function (socket) {				// New connection coming in
	trace('socket connected!');
	socketConnected = true;
	socketIO.emit("upstreamHi",{channel:myChannel}); 		// Register with server and request channel
});

socketIO.on('channel', function (data) {				// Message assigning us a channel
	if (data.channel > 0) {						// Assignment successful
		myChannel = data.channel;
		if (myName == "") myName = "Channel " + myChannel;
		trace('Channel assigned: ',myChannel);
	} else {
		trace("Server unable to assign a channel");		// Server is probaby full
		trace("Try a different server");			// Can't do anything more
		socketConnected = false;
	}
});

// Data coming down from upstream server: Group mix plus separate member audios
socketIO.on('d', function (data) { 
	enterState( dataInState );					// This is one of our key tasks
	packetsIn++;							// For monitoring and statistics
	if ((micAccessAllowed) && (blockSpkr == false)) {		// Need access to audio before outputting
		let mix = [];						// Build up a mix of client audio 
		let chan = data.channels; 
console.log(chan);
		for (let c=0; c < chan.length; c++) {
			if (chan[c].socketID != socketIO.id) {		// Don't include my audio in mix
// Set each channel gain, peak level & name
				let a = chan[c].audio;
				if (mix.length == 0)			// First audio in mix goes straight
					for (let i=0; i < a.length; i++)
						mix[i] = a[i];
  				else
	  				for (let i=0; i < a.length; i++)
						mix[i] += a[i];		// Just add all audio together
			} else {					// This is my own data come back
				let now = new Date().getTime();
				rtt = now - chan[c].timestamp;		// Measure round trip time
			}
		}
		let obj = applyAutoGain(mix,mixGain,1);			// Bring mix level down if necessary
		mixGain = obj.finalGain;				// Store gain for next loop
		if (obj.peak > mixMax) mixMax = obj.peak;		// Note peak for display purposes
		if (mix.length != 0) {					// If there actually was some audio
			spkrBuffer.push(...mix);			// put it on the speaker buffer
			if (spkrBuffer.length > maxBuffSize) {		// Clip buffer if too full
				spkrBuffer.splice(0, (spkrBuffer.length-maxBuffSize)); 	
				overflows++;				// Note for monitoring purposes
			}
		}
	}
	enterState( idleState );					// Back to Idling
});

socketIO.on('disconnect', function () {
	trace('socket disconnected!');
	socketConnected = false;
});







// Media management and display code (audio in and out)
//
document.addEventListener('DOMContentLoaded', function(event){
	setInterval(displayAnimation, 100);				// Call animated display 10 x a second
	let muteBtn=document.getElementById('muteBtn');			// Bind mute code to mute button
	muteBtn.onclick = function () {
		let btn=document.getElementById('muteBtn');
		if (muted == true) {
			muted = false;
			btn.innerText="Mute";
		} else {
			muted = true;
			btn.innerText="Unmute";
		}
	}
});

function displayAnimation() { 						// called 100mS to animate audio displays
	micMax = micMax * 0.9; 						// drop levels a little for smooth drops
	// update displays
	micDisplay(micMax);
}
function micDisplay(level) {
	//if (level > 0) micLED1 = 
}
function setStatusLED(name, level) {					// Set the status LED's colour
	let LED = document.getElementById(name);
	if (level == "Red") LED.className="redLED";
	else if (level == "Orange") LED.className="orangeLED";
	else LED.className="greenLED";
}

function maxValue( arr ) { 						// Find max value in an array
	let max = 0;	
	let v;
	for (let i =  0; i < arr.length; i++) {
		v = Math.abs(arr[i]);					// max ABSOLUTE value
		if (v > max) max = v;
	}
	return max;
}

function applyAutoGain(audio, startGain, maxGain) {			// Auto gain control
	const MaxOutputLevel = 1;					// Max output level permitted
	let tempGain, maxLevel, endGain, p, x, transitionLength; 
	maxLevel = maxValue(audio);					// Find peak audio level 
	endGain = MaxOutputLevel / maxLevel;				// Desired gain to avoid overload
	maxLevel = 0;							// Use this to capture peak
	if (endGain > maxGain) endGain = maxGain;			// Gain is limited to maxGain
	if (endGain >= startGain) {					// Gain adjustment speed varies
		transitionLength = audio.length;			// Gain increases are gentle
		endGain = startGain + ((endGain - startGain)/10);	// Slow the rate of gain change
	}
	else
		transitionLength = Math.floor(audio.length/10);		// Gain decreases are fast
	tempGain = startGain;						// Start at current gain level
	for (let i = 0; i < transitionLength; i++) {			// Adjust gain over transition
		x = i/transitionLength;
		if (i < (2*transitionLength/3))				// Use the Magic formula
			p = 3*x*x/2;					
		else
			p = -3*x*x + 6*x -2;
		tempGain = startGain + (endGain - startGain) * p;
	 	audio[i] = audio[i] * tempGain;
		if (audio[i] >= MaxOutputLevel) audio[i] = MaxOutputLevel;
		else if (audio[i] <= (MaxOutputLevel * -1)) audio[i] = MaxOutputLevel * -1;
		x = Math.abs(audio[i]);
		if (x > maxLevel) maxLevel = x;
	}
	if (transitionLength != audio.length) {				// Still audio left to adjust?
		tempGain = endGain;					// Apply endGain to rest
		for (let i = transitionLength; i < audio.length; i++) {
			audio[i] = audio[i] * tempGain;
			if (audio[i] >= MaxOutputLevel) audio[i] = MaxOutputLevel;
			else if (audio[i] <= (MaxOutputLevel * -1)) audio[i] = MaxOutputLevel * -1;
			x = Math.abs(audio[i]);
			if (x > maxLevel) maxLevel = x;
		}
	}
	return { finalGain: endGain, peak: maxLevel };
}

function processAudio(e) {						// Main processing loop
	// There are two activities here: 
	// 1. Get Mic audio, down-sample it, buffer it, and, if enough, send to server
	// 2. Get audio buffered from server and send to speaker
	
	enterState( audioInOutState );					// Log time spent here
	var inData = e.inputBuffer.getChannelData(0);			// Audio from the mic
	var outData = e.outputBuffer.getChannelData(0);			// Audio going to speaker

	let micAudio = [];						// 1. Mic audio processing...
	if ((socketConnected) && (muted == false)) {			// Need connection to send
		micAudio = downSample(inData, soundcardSampleRate, SampleRate);
		resampledChunkSize = micAudio.length;			// Note how much audio is needed
		micBuffer.push(...micAudio);				// Buffer mic audio until enough
		if (micBuffer.length > PacketSize) {			// Got enough
			let outAudio = micBuffer.splice(0, PacketSize);	// Get a packet of audio
			let obj = applyAutoGain(outAudio, micGain, 10);	// Bring the mic up to level
			if (obj.peak > micMax) micMax = obj.peak;	// Note peak for local display
			micGain = obj.finalGain;			// Store gain for next loop
			let now = new Date().getTime();
			socketIO.emit("u",
			{
				"name"		: myName,		// Send the name we have chosen 
				"audio"		: outAudio,		// Resampled, level-corrected audio
				"sequence"	: packetSequence,	// Usefull for detecting data losses
				"timestamp"	: now,			// Used to measure round trip time
				"peak" 		: obj.peak,		// Saves having to calculate again
				"channel"	: myChannel,		// Send assigned channel to help server
			});
			packetsOut++;					// For stats and monitoring
			packetSequence++;
		}
	}

	let inAudio = [];						// 2. Output audio to speaker
	if (spkrBuffer.length > resampledChunkSize) {			// There is enough audio buffered
		inAudio = spkrBuffer.splice(0,resampledChunkSize);	// Get same amount of audio as came in
	} else {							// Not enough audio.
		inAudio = spkrBuffer.splice(0,spkrBuffer.length);	// Take all that remains and complete with 0s
		let zeros = new Array(resampledChunkSize-spkrBuffer.length).fill(0);
		inAudio.push(...zeros);
		shortages++;						// For stats and monitoring
	}
	let spkrAudio = upSample(inAudio, SampleRate, soundcardSampleRate); // Bring back to HW sampling rate
	for (let i in outData) 
		outData[i] = spkrAudio[i];				// Copy audio to output
	enterState( idleState );					// We are done. Back to Idling
}

function handleAudio(stream) {						// We have obtained media access
	let context = new window.AudioContext || new window.webkitAudioContext;
	soundcardSampleRate = context.sampleRate;
	micAccessAllowed = true;
	let liveSource = context.createMediaStreamSource(stream); 	// Create audio source (mic)
	let node = undefined;
	if (!context.createScriptProcessor) {				// Audio processor node
		node = context.createJavaScriptNode(chunkSize, 1, 1);	// The new way is to use a worklet
	} else {							// but the results are not as good
		node = context.createScriptProcessor(chunkSize, 1, 1);	// and it doesn't work everywhere
	}
	node.onaudioprocess = processAudio;				// Link the callback to the node

	let lowFreq = 100;						// Bandpass to clean up Mic
	let highFreq = 4000;
	let geometricMean = Math.sqrt(lowFreq * highFreq);
	let micFilter = context.createBiquadFilter();
	micFilter.type = 'bandpass';
	micFilter.frequency.value = geometricMean;
	micFilter.Q.value = geometricMean / (highFreq - lowFreq);
	
	let splitter = context.createChannelSplitter(2);		// Split signal for echo cancelling

	let echoDelay = context.createDelay(5);				// Delay to match speaker echo
	echoDelay.delayTime.value = 0.00079

	lowFreq = 300;							// Echo filter to match speaker+mic
	highFreq = 5000;
	geometricMean = Math.sqrt(lowFreq * highFreq);
	let echoFilter = context.createBiquadFilter();
	echoFilter.type = 'bandpass';
	echoFilter.frequency.value = geometricMean;
	echoFilter.Q.value = geometricMean / (highFreq - lowFreq);
	
	let gainNode = context.createGain();				// Cancelling requires inverting signal
	gainNode.gain.value = -1;
									// Time to connect everything...
	liveSource.connect(micFilter);					// Mic goes to micFilter
	micFilter.connect(node);					// micFilter goes to audio processor
	node.connect(splitter);						// our processor feeds to a splitter
	splitter.connect(echoDelay,0);					// one output goes to feedback loop
	splitter.connect(context.destination,0);			// other output goes to speaker
	echoDelay.connect(echoFilter);					// feedback echo goes to echo filter
	echoFilter.connect(gainNode);					// echo filter goes to inverter
	gainNode.connect(micFilter);					// inverter feeds back into micFilter
	gainNode.gain.value = 0;					// Start with feedback loop off
}

document.addEventListener('DOMContentLoaded', function(event){
	initAudio();							// Call initAudio() once loaded
});

function initAudio() {							// Set up all audio handling here
	let constraints = { 						// Try to get the right audio setup
		mandatory: {						// There don't really work though
 			googEchoCancellation: true,
			googAutoGainControl: false,
			googNoiseSuppression: false,
			googHighpassFilter: false 
		}, 
		optional: [] 
	};
	navigator.getUM = (navigator.getUserMedia || navigator.webKitGetUserMedia || navigator.moxGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia);
	if (navigator.mediaDevices.getUserMedia) {			// The new way to request media
		trace("Using GUM with promise");			// is using .mediaDevices and promises
		navigator.mediaDevices.getUserMedia({  audio: constraints }) .then(function (stream) {
			handleAudio(stream);
		})
		.catch(function (e) { trace(e.name + ": " + e.message); });
	} else {							// Not everyone supports this though
		trace("Using OLD GUM");					// So use the old one if necessary
		navigator.getUM({ audio: constraints }, function (stream) {
			handleAudio(stream);
		}, function () { trace("Audio HW is not accessible."); });
	}
}


// Resamplers
//
var  downCache = [0.0,0.0];
function downSample( buffer, originalSampleRate, resampledRate) {
	let resampledBufferLength = Math.round( buffer.length * resampledRate / originalSampleRate );
	let resampleRatio = buffer.length / resampledBufferLength;
	let outputData = new Array(resampledBufferLength).fill(0);
	for ( let i = 0; i < resampledBufferLength - 1; i++ ) {
		let resampleValue = ( resampleRatio - 1 ) + ( i * resampleRatio );
		let nearestPoint = Math.round( resampleValue );
		for ( let tap = -1; tap < 2; tap++ ) {
			let sampleValue = buffer[ nearestPoint + tap ];
			if (isNaN(sampleValue)) sampleValue = upCache[ 1 + tap ];
				if (isNaN(sampleValue)) sampleValue = buffer[ nearestPoint ];
			outputData[ i ] += sampleValue * magicKernel( resampleValue - nearestPoint - tap );
		}
	}
	downCache[ 0 ] = buffer[ buffer.length - 2 ];
	downCache[ 1 ] = outputData[ resampledBufferLength - 1 ] = buffer[ buffer.length - 1 ];
	return outputData;
}

var  upCache = [0.0,0.0];
function upSample( buffer, originalSampleRate, resampledRate) {
	let resampledBufferLength = chunkSize;				// Forcing to always fill the outbuffer fully
	let resampleRatio = buffer.length / resampledBufferLength;
	let outputData = new Array(resampledBufferLength).fill(0);
	for ( var i = 0; i < resampledBufferLength - 1; i++ ) {
		let resampleValue = ( resampleRatio - 1 ) + ( i * resampleRatio );
		let nearestPoint = Math.round( resampleValue );
		for ( let tap = -1; tap < 2; tap++ ) {
			let sampleValue = buffer[ nearestPoint + tap ];
			if (isNaN(sampleValue)) sampleValue = upCache[ 1 + tap ];
				if (isNaN(sampleValue)) sampleValue = buffer[ nearestPoint ];
			outputData[ i ] += sampleValue * magicKernel( resampleValue - nearestPoint - tap );
		}
	}
	upCache[ 0 ] = buffer[ buffer.length - 2 ];
	upCache[ 1 ] = outputData[ resampledBufferLength - 1 ] = buffer[ buffer.length - 1 ];
	return outputData;
}

// From http://johncostella.webs.com/magic/
function magicKernel( x ) {						// This thing is crazy cool
  if ( x < -0.5 ) {							// three curves that map x to y
    return 0.5 * ( x + 1.5 ) * ( x + 1.5 );				// in a harmonic-free manner
  }									// so that up and down sampling 
  else if ( x > 0.5 ) {							// is as clean as possible.
    return 0.5 * ( x - 1.5 ) * ( x - 1.5 );				// All this in 5 lines of code!
  }
  return 0.75 - ( x * x );
}













// Tracing, monitoring, reporting and debugging code
// 
document.addEventListener('DOMContentLoaded', function(event){
	let monitorBtn=document.getElementById('monitorBtn');
	monitorBtn.onclick = function () {
		let monitor=document.getElementById('monitor');
		let monitor2=document.getElementById('monitor2');
		if (monitor.style.visibility == "visible") {
			monitor.style.visibility = "hidden";
			monitor2.style.visibility = "visible";
		} else {
			if (monitor2.style.visibility == "visible")
				monitor2.style.visibility = "hidden";
			else
				monitor.style.visibility = "visible";
		}
	};
	// Buttons used for testing...
	let testBtn=document.getElementById('testBtn');
	testBtn.onclick = function () {
		console.log("Test button pressed");
		if (blockSpkr == true) blockSpkr = false;
		else blockSpkr = true;
		console.log("Tracing = ",blockSpkr);
	};
	let actionBtn=document.getElementById('actionBtn');
	actionBtn.onclick = function () {
		console.log("Action button pressed");
		if (pauseTracing == true) pauseTracing = false;
		else pauseTracing = true;
	};
});
var blockSpkr = false;
var pauseTracing = false;

// Reporting code. Accumulators, interval timer and report generator
//
var packetsIn = 0;
var packetsOut = 0;
var overflows = 0;
var shortages = 0;
var packetSequence = 0;							// Tracing packet ordering
var rtt = 0;
var micMax = 0;								// Max mic level to display on level display
var mixMax = 0;								// Max mix level to display...
var tracecount = 0;
function printReport() {
	trace("Idle = ", idleState.total, " data in = ", dataInState.total, " audio in/out = ", audioInOutState.total);
	trace("Sent = ",packetsOut," Heard = ",packetsIn," speaker buffer size ",spkrBuffer.length," mic buffer size ", micBuffer.length," overflows = ",overflows," shortages = ",shortages," micMax = ",micMax," mixMax = ",mixMax);
	let state = "Green";
	trace2("micMax: ",micMax," micGain: ",micGain," mixMax: ",mixMax," mixGain: ",mixGain);
	if ((overflows > 1) || (shortages >1)) state = "Orange";
	if (socketConnected == false) state = "Red";
	setStatusLED("GeneralStatus",state);
	state = "Green";
	if ((packetsOut < 30) || (packetsOut > 35)) state = "Orange";
	if (packetsOut < 5) state = "Red";
	setStatusLED("UpStatus",state);
	state = "Green";
	if ((packetsIn < 30) || (packetsIn > 35)) state = "Orange";
	if (packetsIn < 5) state = "Red";
	setStatusLED("DownStatus",state);
	packetsIn = 0;
	packetsOut = 0;
	overflows = 0;
	shortages = 0;
	micMax = -2;
	mixMax = -2;
	tracecount = 2;
}

setInterval(printReport, 1000);						// Call report generator once a second


// Tracing to the traceDiv (a Div with id="Trace" in the DOM)
//
var traceDiv = null;
var traceDiv2 = null;
var traceArray = [];
var traceArray2 = [];
var maxTraces = 100;
document.addEventListener('DOMContentLoaded', function(event){
	traceDiv = document.getElementById('Trace');
	traceDiv2 = document.getElementById('Trace2');
});
function trace(){	
	if (pauseTracing == false) {
		let s ="";
		for (let i=0; i<arguments.length; i++)
			s += arguments[i];
		console.log(s);
		traceArray.push(s+"<br>");
		if (traceArray.length > maxTraces) traceArray.shift(0,1);
		if (traceDiv != null) {
			traceDiv.innerHTML = traceArray.join("");
			traceDiv.scrollTop = traceDiv.scrollHeight;
		}
	}
}
function trace2(){	
	if (pauseTracing == false) {
		let s ="";
		for (let i=0; i<arguments.length; i++)
			s += arguments[i];
		console.log(s);
		traceArray2.push(s+"<br>");
		if (traceArray2.length > maxTraces) traceArray2.shift(0,1);
		if (traceDiv2 != null) {
			traceDiv2.innerHTML = traceArray2.join("");
			traceDiv2.scrollTop = traceDiv2.scrollHeight;
		}
	}
}

// Timing counters
//
// We use these to measure how many miliseconds we spend working on events
// and how much time we spend doing "nothing" (supposedly idle)
function stateTimer() {
	this.name = "";
	this.total = 0;
	this.start = 0;
}
var idleState = new stateTimer(); 	idleState.name = "Idle";
var dataInState = new stateTimer();	dataInState.name = "Data In";
var audioInOutState = new stateTimer();	audioInOutState.name = "Audio In/Out";
var currentState = idleState;		currentState.start = new Date().getTime();
function enterState( newState ) {
	let now = new Date().getTime();
	currentState.total += now - currentState.start;
	newState.start = now;
	currentState = newState;
}




enterState( idleState );
trace("Starting V3.0");
