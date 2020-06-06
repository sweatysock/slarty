//Global variables
//
const SampleRate = 16000; 						// Global sample rate used for all audio
const PacketSize = 500;							// Server packet size we must conform to
const MaxRTT = 800;							// Round Trip Times above this will cause a socket reset
var chunkSize = 1024;							// Audio chunk size. Fixed by js script processor
var soundcardSampleRate = null; 					// Get this from context 
var resampledChunkSize = 0;						// Once resampled the chunks are this size
var socketConnected = false; 						// True when socket is up
var micAccessAllowed = false; 						// Need to get user permission
var spkrBuffer = []; 							// Audio buffer going to speaker
var maxBuffSize = 6000;							// Max audio buffer chunks for playback
var micBuffer = [];							// Buffer mic audio before sending
var myChannel = -1;							// The server assigns us an audio channel
var myName = "";							// Name assigned to my audio channel
const NumberOfChannels = 20;						// Max number of channels in this server
var channels = [];							// Each channel's data & buffer held here
for (let i=0; i < NumberOfChannels; i++) {				// Create all the channels pre-initialized
	channels[i] = {
		name	: "",						// Each client names their channel
		gain 	: 1,						// Manual gain level. Start at zero and fade up
		agc	: true,						// Flag if control is manual or auto
		muted	: false,					// Local mute
		peak	: 0,						// Animated peak channel audio level 
		channel	: i,						// The channel needs to know it's number for UI referencing
		seq	:0,						// Track channel sequence numbers to monitor quality
	};
}
var mixOut = {								// Similar structures for the mix output
	name 	: "Output",
	gain	: 0,
	gainRate: 100,
	manGain : 1,
	ceiling : 1,
	agc	: true,
	muted	: false,
	peak	: 0,
	channel	: "mixOut",
	levels	: new Array(20).fill(0),				// Categorizer to build histogram of packet levels
};
var micIn = {								// and for microphone input
	name 	: "Mic",
	gain	: 0,
	gainRate: 1000,
	manGain : 10,
	ceiling : 1,
	agc	: true,
	muted	: false,
	peak	: 0,
	channel	: "micIn",
	levels	: new Array(20).fill(0),				// Categorizer to build histogram of packet levels
	threshold:0.001,						// Level below which we don't send audio
	gate	: 0,							// Threshold gate. >0 means open.
};





// Network code
//
var socketIO = io();
socketIO.on('connect', function (socket) {				// New connection coming in
	trace('socket connected!');
	socketIO.emit("upstreamHi",{channel:myChannel}); 		// Register with server and request channel
});

socketIO.on('channel', function (data) {				// Message assigning us a channel
	if (data.channel > 0) {						// Assignment successful
		myChannel = data.channel;
		if (myName == "") myName = "Channel " + myChannel;
		trace('Channel assigned: ',myChannel);
		socketConnected = true;					// The socket can be used once we have a channel
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
	if (micAccessAllowed) {						// Need access to audio before outputting
		let mix = new Array(PacketSize).fill(0);		// Build up a mix of client audio from 0s
		data.channels.forEach(c => {
			let ch = c.channel;
			if (c.socketID != socketIO.id) {		// Don't include my audio in mix
				channels[ch].name = c.name;		// Update the channel name
				channels[ch].channel = ch;		// Update the channel number
				if (channels[ch].peak < c.peak)		// set the peak for level display
					channels[ch].peak = c.peak;	// even if muted
				if (!channels[ch].muted) {		// We can skip a muted channel
					let a = c.audio;
					let g = channels[ch].gain;	// apply manual gain, if different from 1
	  				for (let i=0; i < a.length; i++)
						mix[i] += a[i] * g;
				}
			} else {					// This is my own data come back
				let now = new Date().getTime();
				rtt = (rtt + (now - c.timestamp))/2;	// Measure round trip time rolling average
				if (rtt > MaxRTT) { 			// If it is too long
//					trace("RTT: ",rtt,"instant rtt: ",(now - c.timestamp)," time: ",now," timestamp: ",c.timestamp," Requsting connection reset");
//					resetConnection();		// reset the socket.
//					rtt = 0;			// reset rtt too.
				}
			}
			if (c.sequence != (channels[ch].seq + 1)) 	// Monitor audio transfer quality
				trace("Sequence jump Channel ",ch," jump ",(c.sequence - channels[ch].seq));
			channels[ch].seq = c.sequence;
		});
//		endTalkover();						// Try to end mic talkover before setting gain
		let obj = applyAutoGain(mix, mixOut);			// Trim mix level 
		mixOut.gain= obj.finalGain;				// Store gain for next loop
		if (obj.peak > mixOut.peak) mixOut.peak = obj.peak;	// Note peak for display purposes
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

var lastReset = new Date().getTime();					// Note previous socket reset to avoid excess resets
function resetConnection() {						// Use this to reset the socket if needed
	let now = new Date().getTime();
	if ((lastReset + 60000) < now) {				// 20 second minimum between socket resets
		trace2("Socket resetting...");
		socketIO.disconnect();
		socketIO.connect();
		lastReset = now
	}
}





// Media management and display code (audio in and out)
//
var displayRefresh = 100;						// mS between UI updates. May be increased if CPU struggling
document.addEventListener('DOMContentLoaded', function(event){
	setTimeout(displayAnimation, displayRefresh);			// Call animated display once. It will need to reset timeout everytime.
});

function displayAnimation() { 						// called 100mS to animate audio displays
	enterState( UIState );						// Measure time spent updating UI
	const rate = 0.7;						// Speed of peak drop in LED level display
	if (micAccessAllowed) {						// Once we have audio we can animate audio UI
		mixOut.peak = mixOut.peak * rate; 			// drop mix peak level a little for smooth drops
		setLevelDisplay( mixOut );				// Update LED display for mix.peak
		setSliderPos( mixOut );					// Update slider position for mix gain
		micIn.peak = micIn.peak * rate; 			// drop mic peak level a little for smooth drops
		setLevelDisplay( micIn );				// Update LED display for mic.peak
		setSliderPos( micIn );					// Update slider position for mic gain
		setThresholdPos( micIn );
		channels.forEach(c => {					// Update each channel's UI
			if (c.name != "") {				// A channel needs a name to be active
				if (c.displayID == undefined)		// If there is no display associated to the channel
					createChannelUI(c);		// build the visuals 
				c.peak = c.peak * rate;			// drop smoothly the max level for the channel
				setLevelDisplay( c );			// update LED display for channel peak
				setSliderPos( c );			// update slider position for channel gain
			}
		});
	}
	if (displayRefresh <= 1000)					// If CPU really struggling stop animating UI completely
		setTimeout(displayAnimation, displayRefresh);		// Call animated display again. 
	enterState( idleState );					// Back to Idling
}

function mapToLevelDisplay( n ) {					// map input to log scale in level display div
	let v = 0;
	if (n > 0.01) 
		v = (10.5 * Math.log10(n) + 21)*65/21;			// v=(10.5log(n)+21)65/21
	return v;
}

function setLevelDisplay( obj ) { 					// Set LED display level for obj
	let v = obj.peak;
	let h1, h2, h3;
	v = mapToLevelDisplay(v);
	if (v < 49.5) {h1 = v; h2 = 0; h3 = 0;} else
	if (v < 58.8) {h1 = 49.5; h2 = (v-49.5); h3 = 0;} else
			{h1 = 49.5; h2 = 9.3; h3 = (v-58.8);}
	let d = document.getElementById(obj.displayID+"LevelGreen");
	d.style.height = h1+"%";
	d = document.getElementById(obj.displayID+"LevelOrange");
	d.style.height = h2+"%";
	d = document.getElementById(obj.displayID+"LevelRed");
	d.style.height = h3+"%";
}

function setThresholdPos( obj ) {					// Set threshold indicator position
	let v = obj.threshold;
	if ((v > 0) && (v < 0.011)) v = 0.011;
	v =  mapToLevelDisplay(v);					// Modifying bottom edge so add 8
	let d = document.getElementById(obj.displayID+"Threshold");
	d.style.height = v+"%";
}

function setSliderPos( obj ) {
	if (obj.gain < 1) pos = (34 * obj.gain) + 8; 
	else
		pos = (2.5 * obj.gain) + 39.5;
	let sl = document.getElementById(obj.displayID + "Slider");
	sl.style.bottom = pos + "%" ;
}

function createChannelUI(obj) {
	let name = "ID"+obj.channel;
	// build UI elements for a single channel with element IDs that include the name requested
	// non LED: <div style="position:absolute;bottom:8%; right:5%; width:40%; height:65%; background-color:#999999" id="'+name+'SlideBox></div> \
	let channel =' <div id="'+name+'" style="position:relative;width:100px; height:100%; display: inline-block"> \
			<img style="position:relative;bottom:0%; right:0%; width:100%; height:99%;" src="images/controlBG.png">  \
			<img style="position:absolute;bottom:8%; right:5%; width:40%; height:10%;" src="images/slider.png" id="'+name+'Slider" >  \
			<div style="position:absolute;bottom:8%; right:5%; width:40%; height:65%;" draggable="false" id="'+name+'SlideBtn" \
				onmousedown="sliderDragStart(event)" onmousemove="sliderDrag(event)" onmouseup="sliderDragStop(event)" \
				ontouchstart="sliderDragStart(event)" ontouchmove="sliderDrag(event)" ontouchend="sliderDragStop(event)"></div>  \
			<img style="position:absolute;right:20%; top:10%;width:50%; padding-bottom:10%;" src="images/channelOff.png" id="'+name+'Off" onclick="unmuteButton(event)">  \
			<img style="position:absolute;right:20%; top:10%;width:50%; padding-bottom:10%;" src="images/channelOn.png" id="'+name+'On" onclick="muteButton(event)">  \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#66FF33" id="'+name+'LevelGreen"></div> \
			<div style="position:absolute;bottom:57.5%; left:25%; width:5%; height:0%; background-color:#FF6600" id="'+name+'LevelOrange"></div> \
			<div style="position:absolute;bottom:66.8%; left:25%; width:5%; height:0%; background-color:#FF0000" id="'+name+'LevelRed"></div> \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#999999" id="'+name+'Threshold"></div> \
			<div style="position:absolute;bottom:8%; left:5%; width:40%; height:65%;" draggable="false" id="'+name+'ThreshBtn" \
				onmousedown="threshDragStart(event)" onmousemove="threshDrag(event)" onmouseup="threshDragStop(event)" \
				ontouchstart="threshDragStart(event)" ontouchmove="threshDrag(event)" ontouchend="threshDragStop(event)"></div>  \
			<div style="position:absolute;top:1%; left:3%; width:90%; height:10%;color:#AAAAAA" id="'+name+'Name"> \
				<marquee behavior="slide" direction="left">'+obj.channel+'</marquee> \
			</div> \
		</div>'
	let mixerRack = document.getElementById("mixerRack");		// Add this collection of items to the mixerRack div
	mixerRack.innerHTML += channel;
	obj.displayID = name;
}

function convertIdToObj(id) {						// Translate HTML DOM IDs to JS data objects
	id = id.substring(2);
	if (parseFloat(id)) id = parseFloat(id);
	if (typeof(id) == "number") {
		id = channels[id];					// ID is channel number so get the channel object
	} else {
		id = eval(id);						// Convert the ID to the object (micIn or mixOut)
	}
	return id;
}

function muteButton(e) {
trace2("mute");
	let id = event.target.parentNode.id;
	let b = document.getElementById(id+"On");
	b.style.visibility = "hidden";
	id = convertIdToObj(id);
	id.muted = true;
}

function unmuteButton(e) {
trace2("unmute");
	let id = event.target.parentNode.id;
	let b = document.getElementById(id+"On");
	b.style.visibility = "visible";
	id = convertIdToObj(id);
	id.muted = false;
}

var slider = {
	dragging:false,							// Flag if slider dragging is happening
	dragStartY:0,							// Y coord where dragging started
	dragStartPct:0,							// start % from bottom for dragged slider
};

function sliderDragStart(event) {
	slider.dragging = true;
	event.target.style.cursor='pointer';				// Make pointer look right
	slider.dragStartY = event.clientY;				// Store where the dragging started
	if (isNaN(slider.dragStartY)) 
		slider.dragStartY = event.touches[0].clientY;		// If it is NaN must be a touchscreen
	let id = event.target.parentNode.id;
	let o = document.getElementById(id+"Slider");
	slider.dragStartPct = parseFloat(o.style.bottom);		// Get the slider's current % position
}

function sliderDrag(event) {
	if (slider.dragging) {
		let y = event.clientY;					// Get current cursor Y coord
		if (isNaN(y)) y = event.touches[0].clientY;		// If it is NaN we must be on a touchscreen
		y = (slider.dragStartY - y);				// Get the cursor positon change
		let pct = (y/event.target.clientHeight*0.65)*100;	// Calculate the change as a % of the range (0.65 is a fudge... coords are wrong but life is short)
		p = slider.dragStartPct + pct;				// Apply the change to the initial position
		let id = event.target.parentNode.id;
		let o = document.getElementById(id+"Slider");
		if (p < 8) p = 8;					// Limit slider movement
		if (p > 65) p = 65;
		o.style.bottom = p;					// Move the slider to the desired position
		let gain;						// Now calculate the gain this position implies
		if (p < 42) 						// Inverse equations used for slider positioning
			gain = (p -8)/34;
		else
			gain = (p - 39.5)/2.5;
		id = convertIdToObj(id);				// Get the js object ID for this UI element
		id.gain = gain;						// Set the object's gain level 
	}
}

function sliderDragStop(event) {
	event.target.style.cursor='default';
	slider.dragging = false;
}

var thresh = {
	dragging:false,							// Flag if thresh dragging is happening
	dragStartY:0,							// Y coord where dragging started
	dragStartPct:0,							// start % from bottom for dragged thresh
};

function threshDragStart(event) {
	thresh.dragging = true;
	event.target.style.cursor='pointer';				// Make pointer look right
	thresh.dragStartY = event.clientY;				// Store where the dragging started
	if (isNaN(thresh.dragStartY)) 
		thresh.dragStartY = event.touches[0].clientY;		// If it is NaN must be a touchscreen
	let id = event.target.parentNode.id;
	let o = document.getElementById(id+"Threshold");
	thresh.dragStartPct = parseFloat(o.style.height);			// Get the thresh's current % position
}

function threshDrag(event) {
	if (thresh.dragging) {
		let y = event.clientY;					// Get current cursor Y coord
		if (isNaN(y)) y = event.touches[0].clientY;		// If it is NaN we must be on a touchscreen
		y = (thresh.dragStartY - y);				// Get the cursor positon change
		let pct = (y/event.target.clientHeight*0.65)*100;	// Calculate the change as a % of the range (0.65 is a fudge... coords are wrong but life is short)
		p = thresh.dragStartPct + pct;				// Apply the change to the initial position
		let id = event.target.parentNode.id;
		let o = document.getElementById(id+"Threshold");
		if (p < 0) p = 0; 					// Limit thresh movement between 0% and 65%
		if (p > 65) p = 65;
		o.style.height = p;					// Move the thresh to the desired position
		if (p > 0) {						// Now calculate the threshold this position implies
			p = p*21/65;
			p = (p-21)/10.5;
			p = Math.pow(10,p);
		}
		id = convertIdToObj(id);				// Get the js object ID for this UI element
		id.threshold = p;					// Set the object's (micIn's) gain level 
	}
}

function threshDragStop(event) {
	event.target.style.cursor='default';
	thresh.dragging = false;
}

function setStatusLED(name, level) {					// Set the status LED's colour
	let LED = document.getElementById(name);
	if (level == "Red") LED.className="redLED";
	else if (level == "Orange") LED.className="orangeLED";
	else LED.className="greenLED";
}




// Audio management code
//
function maxValue( arr ) { 						// Find max value in an array
	let max = 0;	
	let v;
	for (let i =  0; i < arr.length; i++) {
		v = Math.abs(arr[i]);					// max ABSOLUTE value
		if (v > max) max = v;
	}
	return max;
}

function levelClassifier( categories, v ) {
	if (v < 0.0001) categories[0]++; else
	if (v < 0.0002) categories[1]++; else
	if (v < 0.0003) categories[2]++; else
	if (v < 0.0005) categories[3]++; else
	if (v < 0.0007) categories[4]++; else
	if (v < 0.001) categories[5]++; else
	if (v < 0.002) categories[6]++; else
	if (v < 0.003) categories[7]++; else
	if (v < 0.005) categories[8]++; else
	if (v < 0.007) categories[9]++; else
	if (v < 0.01) categories[10]++; else
	if (v < 0.02) categories[11]++; else
	if (v < 0.03) categories[12]++; else
	if (v < 0.05) categories[13]++; else
	if (v < 0.07) categories[14]++; else
	if (v < 0.1) categories[15]++; else
	if (v < 0.2) categories[15]++; else
	if (v < 0.3) categories[16]++; else
	if (v < 0.5) categories[17]++; else
	if (v < 0.7) categories[18]++; else
		categories[19]++
}

function applyAutoGain(audio, obj) {
	let startGain = obj.gain;
	let targetGain = obj.manGain;
	let ceiling = obj.ceiling;
	let gainRate = obj.gainRate;
	let tempGain, maxLevel, endGain, p, x, transitionLength; 
	maxLevel = maxValue(audio);					// Find peak audio level 
	levelClassifier(obj.levels, maxLevel);				// Classify audio for noise analysis
	endGain = ceiling / maxLevel;					// Desired gain to avoid overload
	maxLevel = 0;							// Use this to capture peak
	if (endGain > targetGain) endGain = targetGain;			// No higher than targetGain 
	else obj.gainRate = 10000;					// clipping! slow gain increases - set obj value
	if (endGain >= startGain) {					// Gain adjustment speed varies
		transitionLength = audio.length;			// Gain increases are over entire sample
		endGain = startGain + ((endGain - startGain)/gainRate);	// and are very gentle
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
		if (audio[i] >= ceiling) audio[i] = ceiling;
		else if (audio[i] <= (ceiling * -1)) audio[i] = ceiling * -1;
		x = Math.abs(audio[i]);
		if (x > maxLevel) maxLevel = x;
	}
	if (transitionLength != audio.length) {				// Still audio left to adjust?
		tempGain = endGain;					// Apply endGain to rest
		for (let i = transitionLength; i < audio.length; i++) {
			audio[i] = audio[i] * tempGain;
			if (audio[i] >= ceiling) audio[i] = ceiling;
			else if (audio[i] <= (ceiling * -1)) audio[i] = ceiling * -1;
			x = Math.abs(audio[i]);
			if (x > maxLevel) maxLevel = x;
		}
	}
	return { finalGain: endGain, peak: maxLevel };
}

function applyGain( audio, gain ) {					// Apply a simple gain level to a sample
	for (let i=0; i<audio.length; i++)
		audio[i] = audio[i] * gain;
}

function fadeUp(audio) {						// Fade sample linearly over length
	for (let i=0; i<audio.length; i++)
		audio[i] = audio[i] * (i/audio.length);
}

function fadeDown(audio) {						// Fade sample linearly over length
	for (let i=0; i<audio.length; i++)
		audio[i] = audio[i] * ((audio.length - i)/audio.length);
}

var talkoverLevel = 0.8;						// Ceiling for mix when mic is active
var talkoverLag = 10;							// mS that the half Duplex switch stays set
var talkoverTimer = 0;							// timer used to slow talkover lift off
function talkover() {							// Suppress mix level while mic is active
	let now = new Date().getTime();
	talkoverTimer = now + talkoverLag;			
	mixOut.ceiling = talkoverLevel;
}

function endTalkover() {
	let now = new Date().getTime();
	if (now > talkoverTimer) { 					// Mix ceiling can raise after timeout
		mixOut.ceiling = 1;
		mixOut.gainRate = 10;
	}
}

var echoDelay = 7;							// Number of samples before echo is detected
var thresholdBuffer = new Array(echoDelay).fill(0);			// Thresholds are set from delayed output audio levels
var gateDelay = 5;							// Amount of samples (time) the gate stays open

function processAudio(e) {						// Main processing loop
	// There are two activities here (if not performing an echo test that is): 
	// 1. Get Mic audio, down-sample it, buffer it, and, if enough, send to server
	// 2. Get audio buffered from server and send to speaker
	
	enterState( audioInOutState );					// Log time spent here
	var inData = e.inputBuffer.getChannelData(0);			// Audio from the mic
	var outData = e.outputBuffer.getChannelData(0);			// Audio going to speaker
	let micAudio = [];						// 1. Mic audio processing...

	if (echoTest.running == true) {					// The echo test takes over all audio
		let output = runEchoTest(inData);			// Send the mic audio to the tester
		for (let i in output) 					// and get back audio to reproduce
			outData[i] = output[i];				// Copy audio to output
		enterState( idleState );				// This test stage is done. Back to Idling
		return;							// Don't do anything else while testing
	} 

	// 1. Get Mic audio, buffer it, and send it to server if enough buffered
	if (socketConnected) {						// Need connection to send
		micAudio = downSample(inData, soundcardSampleRate, SampleRate);
		resampledChunkSize = micAudio.length;			// Note how much audio is needed
		micBuffer.push(...micAudio);				// Buffer mic audio until enough
		if (micBuffer.length > PacketSize) {			// Got enough
			let inAudio = micBuffer.splice(0, PacketSize);	// Get a packet of audio
			let obj = applyAutoGain(inAudio, micIn);	// Set mic level to manGain 
			if (obj.peak > micIn.peak) 
				micIn.peak = obj.peak;			// Note peak for local display
			let peak = obj.peak				// peak for packet to be sent
			micIn.gain = obj.finalGain;			// Store gain for next loop
			let diff = obj.peak-micIn.threshold;
if ((micIn.threshold > 0) && (diff > 0)) trace2("mic ",obj.peak.toFixed(3)," thresh ",micIn.threshold.toFixed(3)," Diff ",diff.toFixed(3));
			if (obj.peak > micIn.threshold) {  		// if audio level is above threshold open gate
				if (micIn.gate == 0)
					micIn.gate = gateDelay + 1;	// This signals the gate has just been reopened
				else					// which means fade up the sample
					micIn.gate = gateDelay;
			} 
			if (micIn.gate > 0) {				// If gate is open prepare the audio for sending
//				talkover();				// Mic is active so drop mix output
				micIn.gate--;				// Gate slowly closes
				if (micIn.gate == 0)			// Gate is about to close
					fadeDown(inAudio);		// Fade sample down to zero for smooth sound
				else if (micIn.gate == gateDelay)	// Gate has just been opened so fade up
					fadeUp(inAudio);
			} else {					// Gate closed. Send silent packet
				inAudio = [];
				micIn.peak = 0;
			}
			if (micIn.muted) inAudio = [];			// Muted means sending emply audio
			let now = new Date().getTime();
			socketIO.emit("u",
			{
				"name"		: myName,		// Send the name we have chosen 
				"audio"		: inAudio,		// Resampled, level-corrected audio
				"sequence"	: packetSequence,	// Usefull for detecting data losses
				"timestamp"	: now,			// Used to measure round trip time
				"peak" 		: micIn.peak,		// Saves others having to calculate again
				"channel"	: myChannel,		// Send assigned channel to help server
			});
			packetsOut++;					// For stats and monitoring
			packetSequence++;
		}
	}

	// 2. Take audio buffered from server and send it to the speaker
	let outAudio = [];					
	if (spkrBuffer.length > resampledChunkSize) {			// There is enough audio buffered
		outAudio = spkrBuffer.splice(0,resampledChunkSize);	// Get same amount of audio as came in
	} else {							// Not enough audio.
		outAudio = spkrBuffer.splice(0,spkrBuffer.length);	// Take all that remains and complete with 0s
		let zeros = new Array(resampledChunkSize-spkrBuffer.length).fill(0);
		outAudio.push(...zeros);
		shortages++;						// For stats and monitoring
	}
	let max = maxValue(outAudio);					// Get peak level of this outgoing audio
	thresholdBuffer.push(max);					// push it into dynamic threshold queue
	micIn.threshold = 1.0*thresholdBuffer.splice(0,1);		// set threshold to oldest buffer level
	let spkrAudio = upSample(outAudio, SampleRate, soundcardSampleRate); // Bring back to HW sampling rate
	for (let i in outData) 
		outData[i] = spkrAudio[i];				// Copy audio to output
	enterState( idleState );					// We are done. Back to Idling
}

function handleAudio(stream) {						// We have obtained media access
	let context = new window.AudioContext || new window.webkitAudioContext;
	soundcardSampleRate = context.sampleRate;
	micAccessAllowed = true;
	createChannelUI( mixOut );					// Create the output mix channel UI
	createChannelUI( micIn );					// Create the microphone channel UI
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

	// Time to connect everything...
	liveSource.connect(micFilter);					// Mic goes to micFilter
	micFilter.connect(node);					// micFilter goes to audio processor
	node.connect(splitter);						// our processor feeds to a splitter
	splitter.connect(context.destination,0);			// other output goes to speaker
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






// Echo testing code
//
var echoTest = {
	running		: false,					// Note: 0 means pause and record audio. Number means # of waves per chunk
	steps		: [4,0,0,0,0,0,0,0,0,0,8,0,0,0,0,0,0,0,0,0,16,0,0,0,0,0,0,0,0,0,32,0,0,0,0,0,0,0,0,0,64,0,0,0,0,0,0,0,0,0,128,0,0,0,0,0,0,0,0,0],
	currentStep	: 0,
	currentResults	: 0,
	samples		: [],
	results		: [],
};
echoTest.steps.forEach(i => {
	let halfWave = chunkSize/(i*2);
	let audio = [];
	for  (let s=0; s < chunkSize; s++) {
		audio.push(Math.sin(Math.PI * s / halfWave));
	}
	echoTest.samples[i] = audio;
});

function startEchoTest() {						// Test mic-speaker echo levels
	if (echoTest.running == false) {				// If not testing already
		trace2("Starting echo test");
		echoTest.running = true;				// start testing
		echoTest.currentStep = 0;				// start at step 0 and work through list
	}
}

function runEchoTest(audio) {
	let outAudio;
	if (echoTest.steps[echoTest.currentStep] > 0) {		// >0 means return a sample with that many waves
		outAudio = echoTest.samples[echoTest.steps[echoTest.currentStep]];
		echoTest.currentResults = echoTest.steps[echoTest.currentStep];
		echoTest.results[echoTest.currentResults] = [];	// Get results buffer ready to store audio
	} else {						// 0 means buffer resulting audio coming back through mic
		echoTest.results[echoTest.currentResults].push(...audio);
		outAudio = new Array(chunkSize).fill(0);	// return silence
	}
	echoTest.currentStep++;					// Move to next step with next audio sample
	if (echoTest.currentStep == echoTest.steps.length) {	// At the end of the test cycle
		echoTest.currentStep = 0;			// Back to the start
		echoTest.running = false;			// & stop the test
		for(let i=4;i<=128;i=i*2) {			// Now draw the graphs
			drawWave(echoTest.results[i], "graph"+i);
		}
	}
	return outAudio;
}

function drawWave(audio,n) {
	let str = '<div id="'+n+'" style="position:absolute; bottom:10%; right:5%; width:80%; height:80%; background-color: #222222; visibility: hidden">'+n;
	let max = 0;
	for (let i=0; i<audio.length;i++) {audio[i] = Math.abs(audio[i]); if (audio[i] > max) max = audio[i];}
	for (let i=4;i<(audio.length-4);i++) {
		let l = (i*100)/audio.length;
		let b = 50 + 50*(audio[i-4]+audio[i-3]+audio[i-2]+audio[i-1]+audio[i]+audio[i+1]+audio[i+2]+audio[i+3]+audio[i+4])/9;
		str += '<div style="position:absolute; bottom:'+b+'%;left:'+l+'%;width:1px;height:1px;background-color:#66FF33"></div>';
	}
	max = 50 + 50*max;
	str += '<div style="position:absolute; bottom:'+max+'%;left:0%;width:100%;height:1px;background-color:#FF0000">'+max+'</div>';
	str += '</div>';
	let container = document.getElementById("graphs");
	container.innerHTML += str;
	monitors.push(n);
}







// Tracing, monitoring, reporting and debugging code
// 
var currentMonitor=0;
var monitors = ["none","monitor","monitor2"];
document.addEventListener('DOMContentLoaded', function(event){
	let monitorBtn=document.getElementById('monitorBtn');
	monitorBtn.onclick = function () {
		if (monitors[currentMonitor] != "none") {
			let mon = document.getElementById(monitors[currentMonitor])
			mon.style.visibility = "hidden";
			mon.parentNode.style.visibility = "hidden";
		}
		currentMonitor++;
		if (currentMonitor == monitors.length) currentMonitor = 0;
		if (monitors[currentMonitor] != "none") {
			let mon = document.getElementById(monitors[currentMonitor])
			mon.style.visibility = "visible";
			mon.parentNode.style.visibility = "visible";
		}
	};
	// Buttons used for testing...
	let testBtn=document.getElementById('testBtn');
	testBtn.onclick = function () {
		trace2("Echo Test Button Pressed");
		startEchoTest();
	};
	let actionBtn=document.getElementById('actionBtn');
	actionBtn.onclick = function () {
//		trace("Reset connection pressed");
//		resetConnection();
		trace("Pause traces pressed");
		if (pauseTracing == true) pauseTracing = false;
		else pauseTracing = true;
	};
});
var pauseTracing = false;

// Reporting code. Accumulators, interval timer and report generator
//
var packetsIn = 0;
var packetsOut = 0;
var overflows = 0;
var shortages = 0;
var packetSequence = 0;							// Tracing packet ordering
var rtt = 0;								// Round Trip Time indicates bad network buffering
var tracecount = 0;
var sendShortages = 0;
function printReport() {
	enterState( UIState );						// Measure time spent updating UI even for reporting!
	trace("Idle = ", idleState.total, " data in = ", dataInState.total, " audio in/out = ", audioInOutState.total," UI work = ",UIState.total);
	trace("Sent = ",packetsOut," Heard = ",packetsIn," overflows = ",overflows," shortages = ",shortages," RTT = ",rtt.toFixed(1));
	let state = "Green";
	trace("micIn.peak: ",micIn.peak.toFixed(1)," micIn.gain: ",micIn.gain.toFixed(1)," mixOut.peak: ",mixOut.peak.toFixed(1)," mixOut.gain: ",mixOut.gain.toFixed(1));
	trace("Mic level categories: ",micIn.levels);
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
	if (packetsOut < 30) sendShortages++;				// Monitor if we are sending enough audio
	else sendShortages--;
	if ((sendShortages > 10) && (displayRefresh == 100)) {		// 10 seconds of shortages is bad. Slow UI animation.
trace("Not ending enough audio... slowing animation to 0.5s");
		displayRefresh = 500; sendShortages = 0;
	}
	if ((sendShortages > 10) && (displayRefresh == 500)) {		// 10 more seconds... slow it even more
trace("Still not ending enough audio... slowing animation to 1s");
		displayRefresh = 1000; sendShortages = 0;
	}
	if ((sendShortages > 10) && (displayRefresh == 1000)) {		// another 10 seconds? Stop animation completely.
trace("Still not sending enough audio. Stopping UI animation ");
		displayRefresh = 2000; sendShortages = 0;
	}
	packetsIn = 0;
	packetsOut = 0;
	overflows = 0;
	shortages = 0;
	rtt = 0;
	tracecount = 2;
	enterState( idleState );					// Back to Idling
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
var UIState = new stateTimer();	UIState.name = "UI updating";
var currentState = idleState;		currentState.start = new Date().getTime();
function enterState( newState ) {
	let now = new Date().getTime();
	currentState.total += now - currentState.start;
	newState.start = now;
	currentState = newState;
}




enterState( idleState );
trace("Starting V3.1");
