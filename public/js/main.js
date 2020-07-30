//Global variables
//
const SampleRate = 16000; 						// Global sample rate used for all audio
const HighFilterFreq = SampleRate/2.2;					// Mic filter to remove high frequencies before resampling
const LowFilterFreq = 200;						// Mic filter to remove low frequencies before resampling
const PerfSampleRate = 32000; 						// Global sample rate used for all performer audio
const PacketSize = 500;							// Server packet size we must conform to
const PerfPacketSize = PacketSize*PerfSampleRate/SampleRate;		// Performer packets are larger in order to preserve packet rate
const MaxRTT = 800;							// Round Trip Times above this will cause a socket reset
var chunkSize = 1024;							// Audio chunk size. Fixed by js script processor
var soundcardSampleRate = null; 					// Get this from context 
var resampledChunkSize = 0;						// Once resampled the chunks are this size
var perfResampledChunkSize = 0;						// Perf mode has a different resampled chunk size
var socketConnected = false; 						// True when socket is up
var micAccessAllowed = false; 						// Need to get user permission
var packetBuf = [];							// Buffer of packets sent, subtracted from venue mix later
var spkrBuffer = []; 							// Audio buffer going to speaker
var maxBuffSize = 20000;						// Max audio buffer chunks for playback. 
var micBuffer = [];							// Buffer mic audio before sending
var myChannel = -1;							// The server assigns us an audio channel
var myName = "";							// Name assigned to my audio channel
var myGroup = "individual";						// Group user belongs to. Default is individual.
const NumberOfChannels = 20;						// Max number of channels in this server
var channels = [];							// Each channel's data & buffer held here
for (let i=0; i < NumberOfChannels; i++) {				// Create all the channels pre-initialized
	channels[i] = {
		name	: "",						// Each client names their channel
		gain 	: 1,						// Gain level for the channel
		agc	: true,						// Flag if control is manual or auto
		muted	: false,					// Local mute
		peak	: 0,						// Animated peak channel audio level 
		channel	: i,						// The channel needs to know it's number for UI referencing
		seq	:0,						// Track channel sequence numbers to monitor quality
	};
}
var liveShow = false;							// If there is a live show underway 
var serverLiveChannels = [];						// Server will keep us updated on its live channels here
var mixOut = {								// Similar structures for the mix output
	name 	: "Output",
	gain	: 0,
	gainRate: 100,
	targetGain: 1,
	ceiling : 1,
	agc	: true,
	muted	: false,
	peak	: 0,
	channel	: "mixOut",
};
var micIn = {								// and for microphone input
	name 	: "Mic",
	gain	: 0,
	gainRate: 100,
	targetGain: 1,
	ceiling : 1,
	agc	: true,
	muted	: false,
	peak	: 0,
	channel	: "micIn",
	threshold:0.000,						// Level below which we don't send audio
	gate	: 1,							// Threshold gate. >0 means open.
};
var recording = false;							// Used for testing purposes
var serverMuted = false;

function processCommands(newCommands) {					// Apply commands sent from upstream servers
	if (newCommands.mute != undefined) serverMuted = newCommands.mute; else serverMuted = false;
	if (newCommands.gateDelay != undefined) gateDelay = newCommands.gateDelay;
	if (newCommands.talkoverLevel != undefined) talkoverLevel = newCommands.talkoverLevel;
	if (newCommands.talkoverLag != undefined) talkoverLag = newCommands.talkoverLag;
	if (newCommands.tholdFactor != undefined) echoTest.factor = newCommands.tholdFactor;
	if (newCommands.noiseThreshold != undefined) noiseThreshold = newCommands.noiseThreshold;
	if (newCommands.outGain != undefined);
	if (newCommands.displayURL != undefined);
	if (newCommands.displayText != undefined);
}

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
		if (myName == "") myName = "Input " + myChannel;	// Name my channel if empty
		micIn.name = "Mic ("+ myChannel +")";			// Indicate channel in Mic name
		let id = document.getElementById("ID"+micIn.channel+"Name")
		if (id != null) id.innerHTML = micIn.name;		// Update onscreen name if created
		trace('Channel assigned: ',myChannel);
		socketConnected = true;					// The socket can be used once we have a channel
	} else {
		trace("Server unable to assign a channel");		// Server is probaby full
		trace("Try a different server");			// Can't do anything more
		socketConnected = false;
	}
});

var performer = false;							// Indicates if we are the performer
socketIO.on('perf', function (data) {					// Performer status notification
	performer = data.live;
	if (performer == true) {
		document.getElementById("onair").style.visibility = "visible";
		micFilter1.frequency.value = PerfSampleRate/2.2;	// Change mic filter for performance audio
		micFilter2.frequency.value = 50;
	} else {
		document.getElementById("onair").style.visibility = "hidden";
		micFilter1.frequency.value = HighFilterFreq		// Return mic filter to normal settings
		micFilter2.frequency.value = LowFilterFreq;
	}
});

// Data coming down from upstream server: Group mix plus separate member audios
socketIO.on('d', function (data) { 
console.log("NEW PACKET");
console.log(data);
	enterState( dataInState );					// This is one of our key tasks
	packetsIn++;							// For monitoring and statistics
	serverLiveChannels = data.liveChannels;				// Server live channels are for UI updating
	processCommands(data.commands);					// Process commands from server
	if (micAccessAllowed) {						// Need access to audio before outputting
		// 1. Channel 0 venue mix from server includes our audio sent a few mS ago. Subtract it using seq no. and gain to stop echo
		let mix = [];						// We are here to build a mix
		let venueGain = 0;					// Default venue gain in case there was no channel 0 audio
		if (data.channels[0] != null) {				// If there is venue audio (can't take it for granted)
			venueGain = data.channels[0].gain;		// Channel 0's mix has had this gain applied to all its' channels
			let s = data.channels[0].seqNos[myChannel];	// Channel 0's mix contains our audio. This is its sequence no.
			if (s == null)
				trace("No sequence number for our audio in mix");
			else {
				while (packetBuf.length) {		// Scan the packet buffer for the packet with this sequence
					let p = packetBuf.shift();	// Remove the oldest packet from the buffer
					if (p.sequence == s) {		// We have found the right sequence number
						let a = p.audio;	// Fill mix with my inverted level-corrected audio
						for (let i=0; i < a.length; i++) mix[i] =  -1 * a[i] * venueGain;
						break;			// Packet found. Stop scanning the packet buffer. 
					}
				}
			}
		} else mix = new Array(PacketSize).fill(0);		// If there was no venue audio start with silence
		// 2. Build a mix of all incoming channels. For individuals this is just channel 0, For groups it is more
		data.channels.forEach(c => {				// Process all audio channel packets sent from server
			let ch = c.channel;				// Channel number the packet belongs to
console.log("Mixing channel ",ch);
			let chan = channels[ch];			// Local data structure for this channel
			if (c.socketID != socketIO.id) {		// Don't include my audio in mix
				chan.name = c.name;			// Update local structure's channel name
				chan.channel = ch;			// Keep channel number too. It helps speed lookups
				if (chan.peak < c.peak)			// set the peak for this channel's level display
					chan.peak = c.peak;		// even if muted
				if (!chan.muted) {			// We skip a muted channel in the mix
					let a = c.audio;		// Get the audio from the packet
					let g = (chan.agc 		// Apply gain. If AGC use mix gain, else channel gain
						? mixOut.gain : chan.gain);	
					chan.gain = g;			// Channel gain level should reflect gain used here
	  				for (let i=0; i < a.length; i++)// Add channel to mix, subtracting audio already included
						mix[i] += a[i] * (g - venueGain);	
				}
			} else {					// This is my own data come back
				let now = new Date().getTime();
				rtt = (rtt + (now - c.timestamp))/2;	// Measure round trip time using a rolling average
			}
			if (c.sequence != (chan.seq + 1)) 		// Monitor audio transfer quality for all channels
				trace("Sequence jump Channel ",ch," jump ",(c.sequence - chan.seq));
			chan.seq = c.sequence;
		});
console.log("Mix is now...");
let temp = [];
for (let i=0;i<20;i++) temp[i] = mix[i];
console.log(temp);
		// 3. Upsample the mix, upsample performer audio, mix all together, apply final AGC and send to speaker
		if (mix.length != 0) {					// If there actually was some audio
			mix = reSample(mix, SampleRate, soundcardSampleRate, upCache); // Bring mix to HW sampling rate
			performer = (data.perf.chan == myChannel);	// Update performer flag just in case
			liveShow = data.perf.live;			// Update the live show flag to update display
			if ((data.perf.live) && (!performer)) {		// If there is a live performer and it isn't us
				// MARK Display frame if present
				let a = data.perf.packet.audio;		// Get the performer audio
				a = reSample(a, PerfSampleRate, soundcardSampleRate, upCachePerf); // Bring back to HW sampling rate
				for (let i=0; i < a.length; i++)
					mix[i] += a[i];			// Performer audio goes straight into mix
			}
//			endTalkover();					// Try to end mic talkover before setting gain
			let obj = applyAutoGain(mix, mixOut);		// Trim mix level 
			mixOut.gain= obj.finalGain;			// Store gain for next loop
			if (obj.peak > mixOut.peak) mixOut.peak = obj.peak;	// Note peak for display purposes
if (obj.peak > 0) {
console.log("output above zero...");
console.log(mix);
}
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
var displayRefresh = 100;						// mS between UI updates. MARK change to animation frame

function displayAnimation() { 						// called 100mS to animate audio displays
	enterState( UIState );						// Measure time spent updating UI
	const rate = 0.8;						// Speed of peak drop in LED level display
	if (micAccessAllowed) {						// Once we have audio we can animate audio UI
		mixOut.peak = mixOut.peak * rate; 			// drop mix peak level a little for smooth drops
		setLevelDisplay( mixOut );				// Update LED display for mix.peak
		setSliderPos( mixOut );					// Update slider position for mix gain
		micIn.peak = micIn.peak * rate; 			// drop mic peak level a little for smooth drops
		setLevelDisplay( micIn );				// Update LED display for mic.peak
		setSliderPos( micIn );					// Update slider position for mic gain
		setThresholdPos( micIn );
		for (let ch in channels) {				// Update each channel's UI
			c = channels[ch];
			if (c.name != "") {				// A channel needs a name to be active
				if (serverLiveChannels[ch] == null)	// Channel must have disconnected. 
					removeChannelUI(c);		// Remove its UI presence
				else {
					if (c.displayID == undefined)	// If there is no display associated to the channel
						createChannelUI(c);	// build the visuals 
					c.peak = c.peak * rate;		// drop smoothly the max level for the channel
					setLevelDisplay( c );		// update LED display for channel peak
					setSliderPos( c );		// update slider position for channel gain
				}
			}
		}
	}
	if (displayRefresh <= 1000)					// If CPU really struggling stop animating UI completely
		setTimeout(displayAnimation, displayRefresh);		// Call animated display again. 
	enterState( idleState );					// Back to Idling
}

function toggleSettings() {						// Hide/show settings = mixing desk
	let d = document.getElementById("mixerViewer");
	if (d.style.visibility == "hidden") {
		d.style.visibility = "visible";
		displayRefresh = 100;
		setTimeout(displayAnimation, displayRefresh);
	} else {
		d.style.visibility = "hidden";
		displayRefresh = 2000;
	}
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
	let gain = obj.gain;						// With AGC slider shows actual gain, otherwise manual gain
	if (gain < 1) pos = (34 * gain) + 8; 
	else
		pos = (2.5 * gain) + 39.5;
	let sl = document.getElementById(obj.displayID + "Slider");
	sl.style.bottom = pos + "%" ;
}

function createChannelUI(obj) {						// build single channel UI with IDs using name requested
	let name = "ID"+obj.channel;
	let channel =' <div id="'+name+'" style="position:relative;width:100px; height:100%; display: inline-block"> \
			<img style="position:relative;bottom:0%; right:0%; width:100%; height:99%;" src="images/controlBG.png">  \
			<img style="position:absolute;bottom:8%; right:5%; width:40%; height:10%;" src="images/slider.png" id="'+name+'Slider" >  \
			<div style="position:absolute;bottom:8%; right:5%; width:90%; height:65%;" draggable="false" id="'+name+'SlideBtn" \
				onmousedown="sliderDragStart(event)" onmousemove="sliderDrag(event)" onmouseup="sliderDragStop(event)" \
				ontouchstart="sliderDragStart(event)" ontouchmove="sliderDrag(event)" ontouchend="sliderDragStop(event)"></div>  \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#66FF33" id="'+name+'LevelGreen"></div> \
			<div style="position:absolute;bottom:57.5%; left:25%; width:5%; height:0%; background-color:#FF6600" id="'+name+'LevelOrange"></div> \
			<div style="position:absolute;bottom:66.8%; left:25%; width:5%; height:0%; background-color:#FF0000" id="'+name+'LevelRed"></div> \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#999999" id="'+name+'Threshold"></div> \
			<img style="position:absolute;right:30%; top:10%;width:40%; padding-bottom:10%;" src="images/channelOff.png" id="'+name+'Off" onclick="unmuteButton(event)">  \
			<img style="position:absolute;right:30%; top:10%;width:40%; padding-bottom:10%;" src="images/channelOn.png" id="'+name+'On" onclick="muteButton(event)">  \
			<img style="position:absolute;right:30%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOff.png" id="'+name+'AGCOff" onclick="agcButton(event)">  \
			<img style="position:absolute;right:30%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOn.png" id="'+name+'AGCOn" onclick="agcButton(event)">  \
			<div style="position:absolute;top:1%; left:3%; width:90%; height:10%;color:#AAAAAA" id="'+name+'Name"> \
				<marquee behavior="slide" direction="left">'+obj.name+'</marquee> \
			</div> \
		</div>'
	let mixerRack = document.getElementById("mixerRack");		// Add this collection of items to the mixerRack div
	mixerRack.innerHTML += channel;
	obj.displayID = name;
}

function createOutputUI(obj) {						// UI for output channel
	let name = "ID"+obj.channel;
	let channel =' <div id="'+name+'" style="position:relative;width:100px; height:100%; display: inline-block"> \
			<img style="position:relative;bottom:0%; right:0%; width:100%; height:99%;" src="images/controlBG.png">  \
			<img style="position:absolute;bottom:8%; right:5%; width:40%; height:10%;" src="images/slider.png" id="'+name+'Slider" >  \
			<div style="position:absolute;bottom:8%; right:5%; width:90%; height:65%;" draggable="false" id="'+name+'SlideBtn" \
				onmousedown="sliderDragStart(event)" onmousemove="sliderDrag(event)" onmouseup="sliderDragStop(event)" \
				ontouchstart="sliderDragStart(event)" ontouchmove="sliderDrag(event)" ontouchend="sliderDragStop(event)"></div>  \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#66FF33" id="'+name+'LevelGreen"></div> \
			<div style="position:absolute;bottom:57.5%; left:25%; width:5%; height:0%; background-color:#FF6600" id="'+name+'LevelOrange"></div> \
			<div style="position:absolute;bottom:66.8%; left:25%; width:5%; height:0%; background-color:#FF0000" id="'+name+'LevelRed"></div> \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#999999" id="'+name+'Threshold"></div> \
			<img style="position:absolute;right:5%; top:9%;width:90%; padding-bottom:10%;object-fit: scale-down;visibility: hidden" src="images/live.png" id="'+name+'live" >  \
			<img style="position:absolute;right:30%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOff.png" id="'+name+'AGCOff" onclick="agcButton(event)">  \
			<img style="position:absolute;right:30%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOn.png" id="'+name+'AGCOn" onclick="agcButton(event)">  \
			<div style="position:absolute;top:1%; left:3%; width:90%; height:10%;color:#AAAAAA" id="'+name+'Name"> \
				<marquee behavior="slide" direction="left">'+obj.name+'</marquee> \
			</div> \
		</div>'
	let mixerRack = document.getElementById("mixerRack");		// Add this collection of items to the mixerRack div
	mixerRack.innerHTML += channel;
	obj.displayID = name;
}

function createMicUI(obj) {						// UI for mic input channel
	let name = "ID"+obj.channel;
	let channel =' <div id="'+name+'" style="position:relative;width:100px; height:100%; display: inline-block"> \
			<img style="position:relative;bottom:0%; right:0%; width:100%; height:99%;" src="images/controlBG.png">  \
			<img style="position:absolute;bottom:8%; right:5%; width:40%; height:10%;" src="images/slider.png" id="'+name+'Slider" >  \
			<div style="position:absolute;bottom:8%; right:5%; width:90%; height:65%;" draggable="false" id="'+name+'SlideBtn" \
				onmousedown="sliderDragStart(event)" onmousemove="sliderDrag(event)" onmouseup="sliderDragStop(event)" \
				ontouchstart="sliderDragStart(event)" ontouchmove="sliderDrag(event)" ontouchend="sliderDragStop(event)"></div>  \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#66FF33" id="'+name+'LevelGreen"></div> \
			<div style="position:absolute;bottom:57.5%; left:25%; width:5%; height:0%; background-color:#FF6600" id="'+name+'LevelOrange"></div> \
			<div style="position:absolute;bottom:66.8%; left:25%; width:5%; height:0%; background-color:#FF0000" id="'+name+'LevelRed"></div> \
			<div style="position:absolute;bottom:8%; left:25%; width:5%; height:0%; background-color:#999999" id="'+name+'Threshold"></div> \
			<img style="position:absolute;right:5%; top:10%;width:40%; padding-bottom:10%;" src="images/channelOff.png" id="'+name+'Off" onclick="unmuteButton(event)">  \
			<img style="position:absolute;right:5%; top:10%;width:40%; padding-bottom:10%;" src="images/channelOn.png" id="'+name+'On" onclick="muteButton(event)">  \
			<img style="position:absolute;left:5%; top:10%;width:40%; padding-bottom:10%;" src="images/talkOff.png" id="'+name+'talkOff" >  \
			<img style="position:absolute;left:5%; top:10%;width:40%; padding-bottom:10%;" src="images/talkOn.png" id="'+name+'talkOn" >  \
			<img style="position:absolute;right:5%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOff.png" id="'+name+'AGCOff" onclick="agcButton(event)">  \
			<img style="position:absolute;right:5%; bottom:1%;width:40%; padding-bottom:10%;" src="images/AGCOn.png" id="'+name+'AGCOn" onclick="agcButton(event)">  \
			<img style="position:absolute;left:5%; bottom:1%;width:40%; padding-bottom:10%;" src="images/NROff.png" id="'+name+'NROff" ">  \
			<img style="position:absolute;left:5%; bottom:1%;width:40%; padding-bottom:10%;" src="images/NROn.png" id="'+name+'NROn" ">  \
			<div style="position:absolute;top:1%; left:3%; width:90%; height:10%;color:#AAAAAA" id="'+name+'Name"> \
				<marquee behavior="slide" direction="left">'+obj.name+'</marquee> \
			</div> \
		</div>'
	let mixerRack = document.getElementById("mixerRack");		// Add this collection of items to the mixerRack div
	mixerRack.innerHTML += channel;
	obj.displayID = name;
}

// Keeping this handy for now...
//			<img style="position:absolute;left:5%; top:10%;width:40%; padding-bottom:10%;" src="images/talkOn.png" id="'+name+'talkOn" onclick="recButton(event)">  \

function removeChannelUI(obj) {
	trace2("Removing channel ",obj.name);
	let chan = document.getElementById(obj.displayID);
	chan.remove();							// Remove from UI
	obj.displayID	= undefined;					// Reset all variables except channel #
	obj.name 	= "";						
	obj.gain	= 1;					
	obj.agc		= true;				
	obj.muted	= false;		
	obj.peak	= 0;		
	obj.seq		= 0;
}

function convertIdToObj(id) {						// Translate HTML DOM IDs to JS data objects
	id = id.substring(2);
	if (parseFloat(id)) id = parseFloat(id);
	if ((typeof(id) == "number") || (id == "0")) {			// 0 seems not to come through as a number
		id = channels[id];					// ID is channel number so get the channel object
	} else {
		id = eval(id);						// Convert the ID to the object (micIn or mixOut)
	}
	return id;
}

function recButton(e) {
trace2("rec");
	let id = event.target.parentNode.id;
	let b = document.getElementById(id+"talkOn");
	b.style.visibility = "hidden";
	id = convertIdToObj(id);
	recording = true;
}

function muteButton(e) {
	let id = event.target.parentNode.id;
trace2("mute ",id);
	let b = document.getElementById(id+"On");
	b.style.visibility = "hidden";
	id = convertIdToObj(id);
	id.muted = true;
}

function agcButton(e) {
	let id = event.target.parentNode.id;
	let oid = convertIdToObj(id);
	let b = document.getElementById(id+"AGCOn");
	if (oid.agc) {
		b.style.visibility = "hidden";
trace2("agc off");
	} else {
		b.style.visibility = "inherit";
trace2("agc on");
	}
	oid.agc = !oid.agc;
}

function unmuteButton(e) {
trace2("unmute");
	let id = event.target.parentNode.id;
	let b = document.getElementById(id+"On");
	b.style.visibility = "inherit";
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
		let agc = document.getElementById(id+"AGCOn");
		agc.style.visibility = "hidden";				// By sliding the fader AGC is switched off. Hide indicator
		let gain;						// Now calculate the gain this position implies
		if (p < 42) 						// Inverse equations used for slider positioning
			gain = (p -8)/34;
		else
			gain = (p - 39.5)/2.5;
		id = convertIdToObj(id);				// Get the js object ID for this UI element
		id.gain = gain;						// Set the object's gain level 
//		if (id.targetGain != undefined) id.targetGain = gain;	// If this object has a target gain manually set it too
		id.agc = false;						// AGC is now off for this object
	}
}

function sliderDragStop(event) {
	event.target.style.cursor='default';
	slider.dragging = false;
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

function avgValue( arr ) { 						// Find average value in an array
	let t = 0;
	for (let i =  0; i < arr.length; i++) {
		t += Math.abs(arr[i]);					// average ABSOLUTE value
	}
	return (t/arr.length);
}

function applyAutoGain(audio, obj) {
	let startGain = obj.gain;
	let targetGain = obj.targetGain;
	let ceiling = obj.ceiling;
	let negCeiling = ceiling * -1;
	let gainRate = obj.gainRate;
	let agc = obj.agc;
	let tempGain, maxLevel, endGain, p, x, transitionLength; 
	if (!agc) targetGain = startGain;				// If no AGC not much to do. Just clip and apply ceiling
	maxLevel = maxValue(audio);					// Find peak audio level 
	endGain = ceiling / maxLevel;					// Our endGain can never exceed this to avoid overload
	maxLevel = 0;							// Use this to capture peak
	if (endGain > targetGain) endGain = targetGain;			// endGain is the max, but if target is lower then use that
	else {
//		obj.gainRate = 10000;					// clipping! slow gain increases - set obj value
		trace2("Clipping gain");
	}
	if (endGain >= startGain) {					// Gain adjustment speed varies
		transitionLength = audio.length;			// Gain increases are over entire sample
		if (agc) endGain = startGain 				// and, if using AGC, are very gentle
			+ ((endGain - startGain)/gainRate);	 	
	}
	else {
		transitionLength = Math.floor(audio.length/10);		// Gain decreases are fast
		trace2("Gain dropping");
	}
	tempGain = startGain;						// Start at current gain level
	for (let i = 0; i < transitionLength; i++) {			// Adjust gain over transition
		x = i/transitionLength;
//		if (i < (2*transitionLength/3))				// Use the Magic formula
//			p = 3*x*x/2;					
//		else
//			p = -3*x*x + 6*x -2;
//		tempGain = startGain + (endGain - startGain) * p;
		tempGain = startGain + (endGain - startGain) * x;
	 	audio[i] = audio[i] * tempGain;
		if (audio[i] >= ceiling) audio[i] = ceiling;
		else if (audio[i] <= negCeiling) audio[i] = negCeiling;
		x = Math.abs(audio[i]);
		if (x > maxLevel) maxLevel = x;
	}
	if (transitionLength != audio.length) {				// Still audio left to adjust?
		tempGain = endGain;					// Apply endGain to rest
		for (let i = transitionLength; i < audio.length; i++) {
			audio[i] = audio[i] * tempGain;
			if (audio[i] >= ceiling) audio[i] = ceiling;
			else if (audio[i] <= negCeiling) audio[i] = negCeiling;
			x = Math.abs(audio[i]);
			if (x > maxLevel) maxLevel = x;
		}
	}
	if (ceiling != 1) endGain = startGain;				// If talkover ceiling impact on gain is temporary
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

var talkoverLevel = 0.01;						// Ceiling for mix when mic is active, 0 = half duplex
if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) 		// If we are on Firefox echo cancelling is good 
	talkoverLevel = 1;
var talkoverLag = 50;							// mS that talkover endures after mic goes quiet
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
	}
}

var thresholdBands = [0.0001, 0.0002, 0.0003, 0.0005, 0.0007, 0.001, 0.002, 0.003, 0.005, 0.007, 0.01, 0.02, 0.03, 0.05, 0.07, 0.1, 0.2, 0.3, 0.5, 0.7, 1, 2];
var levelCategories = new Array(thresholdBands.length).fill(0);		// Categorizer to build histogram of packet levels
function levelClassifier( v ) {
	for (let i=0; i<thresholdBands.length; i++) {
		if (v < thresholdBands[i]) {
			levelCategories[i]++;
			break;
		}
	}
}

var noiseThreshold = 0.02;							// Base threshold for mic signal
function setNoiseThreshold () {						// Set the mic threshold to remove most background noise
	let max = 0;
	for (let i=0; i<14; i++)
		if (levelCategories[i] > max) {				// Find the peak category for sample levels
			max = levelCategories[i];
			noiseThreshold = thresholdBands[i];		// Threshold set to remove all below the peak
		}
	noiseThreshold = noiseThreshold * 1.2;				// Give noise threshold a little boost
trace2("Noise threshold: ",noiseThreshold);
	if (max > 0)
		for (let i=0; i<14; i++)
			levelCategories[i] = 
				((levelCategories[i]/max)*100.0);	// Keep old data to obtain slower threshold changes
}

var thresholdBuffer = new Array(20).fill(0);				// Buffer dynamic thresholds here for delayed mic muting
var gateDelay = 30;							// Amount of samples (time) the gate stays open

function processAudio(e) {						// Main processing loop
	// There are two activities here (if not performing an echo test that is): 
	// 1. Get Mic audio, down-sample it, buffer it, and, if enough, send to server
	// 2. Get audio buffered from server and send to speaker
	
	enterState( audioInOutState );					// Log time spent here

	var inData = e.inputBuffer.getChannelData(0);			// Audio from the mic
	var outData = e.outputBuffer.getChannelData(0);			// Audio going to speaker

	if (echoTest.running == true) {					// The echo test takes over all audio
		let output = runEchoTest(inData);			// Send the mic audio to the tester
		for (let i in output) 					// and get back audio to reproduce
			outData[i] = output[i];				// Copy audio to output
		enterState( idleState );				// This test stage is done. Back to Idling
		return;							// Don't do anything else while testing
	} 

	// 1. Get Mic audio, buffer it, and send it to server if enough buffered
	if (socketConnected) {						// Need connection to send
		let micAudio = [];					// Our objective is to fill this with audio
		let peak = maxValue(inData);				// Get peak of raw mic audio
		if (!pauseTracing) levelClassifier(peak);		// Classify audio incoming for analysis
		if ((peak > micIn.threshold) &&				// if audio is above dynamic threshold
			(peak > noiseThreshold)) {			// and noise threshold, open gate
			if (micIn.gate == 0)
				micIn.gate = gateDelay + 1;		// This signals the gate has just been reopened
			else						// which means fade up the sample
				micIn.gate = gateDelay;
		} 
		if (performer) micIn.gate = 1				// Performer's mic is always open
		let sr = (performer ? PerfSampleRate : SampleRate);	// Set sample rate to normal or performer rate
		let cache = (performer ? downCachePerf : downCache);	// Use the correct resample cache
		if (micIn.gate > 0) {					// If gate is open prepare the audio for sending
			micAudio = reSample(inData, soundcardSampleRate, sr, cache);
			micIn.gate--;					// Gate slowly closes
//			if (micIn.gate == 0)				// Gate is about to close
//				fadeDown(micAudio);			// Fade sample down to zero for smooth sound
//			else if (micIn.gate == gateDelay)		// Gate has just been opened so fade up
//				fadeUp(micAudio);
		} else {						// Gate closed. Fill with silence.
			if (performer)					// Fill with 0's relevant amount of samples
				micAudio = new Array(perfResampledChunkSize).fill(0);
			else
				micAudio = new Array(resampledChunkSize).fill(0);
		}
		micBuffer.push(...micAudio);				// Buffer mic audio 
		let ps = (performer ? PerfPacketSize : PacketSize);	// Packet size depends on performer mode
		if (micBuffer.length > ps) {				// If enough in buffer to fill a packet
			let inAudio = micBuffer.splice(0, ps);		// Get a packet of audio (larger if performer)
			let obj = applyAutoGain(inAudio, micIn);	// Amplify mic with auto limiter
			if (obj.peak > micIn.peak) 
				micIn.peak = obj.peak;			// Note peak for local display
			peak = obj.peak					// peak for packet to be sent
			micIn.gain = obj.finalGain;			// Store gain for next loop
			if ((peak == 0) || (micIn.muted) || 		// Send empty packet if silent, muted
				(serverMuted && !performer)) { 		// or muted by server and not performer
				inAudio = [];				// Send empty audio packet
				peak = 0;
			} else {
//				talkover();				// Mic is active so drop mix output
			}
			let now = new Date().getTime();
			let packet = {
				"name"		: myName,		// Send the name we have chosen 
				"audio"		: inAudio,		// Resampled, level-corrected audio
				"sequence"	: packetSequence,	// Usefull for detecting data losses
				"timestamp"	: now,			// Used to measure round trip time
				"peak" 		: peak,			// Saves others having to calculate again
				"channel"	: myChannel,		// Send assigned channel to help server
				"recording"	: recording,		// Flag used for recording - test function
				"sampleRate"	: sr,			// Send sample rate to help processing
				"group"		: myGroup,		// Group name this user belings to
			};
			socketIO.emit("u",packet);
			packetBuf.push(packet);				// Add sent packet to LILO buffer for echo cancelling 
			packetsOut++;					// For stats and monitoring
			packetSequence++;
		}
	}

	// 2. Take audio buffered from server and send it to the speaker
	let outAudio = [];					
	if (spkrBuffer.length > chunkSize) {				// There is enough audio buffered
		outAudio = spkrBuffer.splice(0,chunkSize);		// Get same amount of audio as came in
	} else {							// Not enough audio.
		outAudio = spkrBuffer.splice(0,spkrBuffer.length);	// Take all that remains and complete with 0s
		let zeros = new Array(chunkSize-spkrBuffer.length).fill(0);
		outAudio.push(...zeros);
		shortages++;						// For stats and monitoring
	}
	let max = maxValue(outAudio);					// Get peak level of this outgoing audio
	thresholdBuffer.unshift( max );					// add to start of dynamic threshold queue
	micIn.threshold = (maxValue([					// Apply most aggressive threshold near current +/-1
		thresholdBuffer[echoTest.sampleDelay-2],
		thresholdBuffer[echoTest.sampleDelay-1],
		thresholdBuffer[echoTest.sampleDelay],	
		thresholdBuffer[echoTest.sampleDelay+1],
		thresholdBuffer[echoTest.sampleDelay+2]
	])) * echoTest.factor * mixOut.gain;				// multiply by factor and mixOutGain
	thresholdBuffer.pop();						// Remove oldest threshold buffer value
	for (let i in outData) 
		outData[i] = outAudio[i];				// Copy audio to output
	enterState( idleState );					// We are done. Back to Idling
}

var micFilter1;
var micFilter2;
function handleAudio(stream) {						// We have obtained media access
	let context;
	let AudioContext = window.AudioContext 				// Default
		|| window.webkitAudioContext 				// Safari and old versions of Chrome
		|| false; 
	if (AudioContext) {
		context = new AudioContext();
	} else {
		alert("Sorry, the Web Audio API is not supported by your browser. Consider upgrading or using Google Chrome or Mozilla Firefox");
	}
	soundcardSampleRate = context.sampleRate;			// Get HW sample rate... varies per platform
	resampledChunkSize = Math.floor(chunkSize * 			// Calculate size of internal data chunks
		SampleRate / soundcardSampleRate);			// for internal audence sample rate
	perfResampledChunkSize = Math.floor(chunkSize *			// Same for performer mode audio too
		PerfSampleRate / soundcardSampleRate);
	micAccessAllowed = true;
	createOutputUI( mixOut );					// Create the output mix channel UI
	createMicUI( micIn );						// Create the microphone channel UI
	let liveSource = context.createMediaStreamSource(stream); 	// Create audio source (mic)
	let node = undefined;
	if (!context.createScriptProcessor) {				// Audio processor node
		node = context.createJavaScriptNode(chunkSize, 1, 1);	// The new way is to use a worklet
	} else {							// but the results are not as good
		node = context.createScriptProcessor(chunkSize, 1, 1);	// and it doesn't work everywhere
	}
	node.onaudioprocess = processAudio;				// Link the callback to the node

	let combiner = context.createChannelMerger();			// Combiner node to turn stereo input to mono

	micFilter1 = context.createBiquadFilter();
	micFilter1.type = 'lowpass';
	micFilter1.frequency.value = HighFilterFreq;
	micFilter1.Q.value = 1;
	micFilter2 = context.createBiquadFilter();
	micFilter2.type = 'highpass';
	micFilter2.frequency.value = LowFilterFreq;
	micFilter2.Q.value = 1;
	
	let splitter = context.createChannelSplitter(2);		// Split signal for echo cancelling

	// Time to connect everything...
	liveSource.connect(combiner);					// Mic goes to combiner
	combiner.connect(micFilter1);					// Combiner goes to micFilter1
	micFilter1.connect(micFilter2);					// the rest are chained togather
	micFilter2.connect(node);					// micFilter goes to audio processor
	node.connect(splitter);						// our processor feeds to a splitter
	splitter.connect(context.destination,0);			// other output goes to speaker

	startEchoTest();
}


	
document.addEventListener('DOMContentLoaded', function(event){
	initAudio();							// Call initAudio() once loaded
});

function initAudio() {							// Set up all audio handling here
	let constraints = { 						// Try to get the right audio setup
		mandatory: {						// These don't really work though!
 			googEchoCancellation: false,
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


// Resampler
//
var  downCache = [0.0,0.0];						// Resampling cache for audio from mic
var  upCache = [0.0,0.0];						// cache for audio mix to speaker
var  downCachePerf = [0.0,0.0];						// cache for performer audio from mic
var  upCachePerf = [0.0,0.0];						// cache for performer audio to mix and send to speaker
function reSample( buffer, originalSampleRate, resampledRate, cache) {
	let resampledBufferLength = Math.floor( buffer.length * resampledRate / originalSampleRate );
	let resampleRatio = buffer.length / resampledBufferLength;
	let outputData = new Array(resampledBufferLength).fill(0);
	for ( let i = 0; i < resampledBufferLength - 1; i++ ) {
		let resampleValue = ( resampleRatio - 1 ) + ( i * resampleRatio );
		let nearestPoint = Math.round( resampleValue );
		for ( let tap = -1; tap < 2; tap++ ) {
			let sampleValue = buffer[ nearestPoint + tap ];
			if (isNaN(sampleValue)) sampleValue = cache[ 1 + tap ];
				if (isNaN(sampleValue)) sampleValue = buffer[ nearestPoint ];
			outputData[ i ] += sampleValue * magicKernel( resampleValue - nearestPoint - tap );
		}
	}
	cache[ 0 ] = buffer[ buffer.length - 2 ];
	cache[ 1 ] = outputData[ resampledBufferLength - 1 ] = buffer[ buffer.length - 1 ];
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
	running		: false,
	steps		: [16,8,128,64,32,1,0.5,0.2,0.1,0.05,0.02,0],	// Test frequencies and levels ended with 0
	currentStep	: 0,						// Points to test step being executed
	analysisStep	: 0,						// Points to test step being analysed
	tones		: [],						// Tones for each test are held here
	samplesNeeded 	: 0,						// Indicates how many samples still to store
	results		: [],						// Samples of each test buffer here
	delays 		: [],						// Array of final measurements
	delay		: 129,	// Default value			// Final delay measurement result stored here
	factor		: 2,	// Default value			// Final sensitivity factor stored here
	sampleDelay	: 6,	// Default value			// Final number of samples to delay dynamic threshold by
};

echoTest.steps.forEach(i => {						// Build test tones
	if (i>1) {							// Create waves of different frequencies
		let halfWave = chunkSize/(i*2);
		let audio = [];
		for  (let s=0; s < chunkSize; s++) {
			audio.push(Math.sin(Math.PI * s / halfWave));
		}
		echoTest.tones[i] = audio;
	} else if (i > 0) {						// Create 1411Hz waves at different levels
		let halfWave = chunkSize/64;
		let audio = [];
		let gain = i;
		for  (let s=0; s < chunkSize; s++) {
			audio.push(gain * Math.sin(Math.PI * s / halfWave));
		}
		echoTest.tones[i] = audio;
	}
});

function startEchoTest() {						// Test mic-speaker echo levels
	if (echoTest.running == false) {				// If not testing already
		trace2("Starting echo test");
		echoTest.running = true;				// start testing
		echoTest.currentStep = 0;				// start at step 0 and work through list
		echoTest.analysisStep = 0;				// reset the analysis pointer too
		echoTest.results = [];					// clear out results for new test
		echoTest.delays = [];					// clear out final mesaurements too
	}
}

function runEchoTest(audio) {						// Test audio system in a series of tests
	let outAudio;
	let test = echoTest.steps[echoTest.currentStep];
	if (test > 0) {							// 0 means analyze. >0 means emit & record audio
		if (echoTest.samplesNeeded == 0) {			// If not storing audio must be sending test sound
			trace2("Running test ",test);
			outAudio = echoTest.tones[test]; 		// Get test sound for this test
			echoTest.results[test] = [];			// Get results buffer ready to store audio
			echoTest.samplesNeeded = 10;			// Request 10 audio samples for each test
		} else {						// else samples need to be buffered
			echoTest.results[test].push(...audio);
			outAudio = new Array(chunkSize).fill(0);	// return silence to send to speaker
			echoTest.samplesNeeded--;			// One sample less needed
			if (echoTest.samplesNeeded == 0)		// If no more samples needed
				echoTest.currentStep++;			// move to next step
		}
	} else {							// Test completed. "0" indicates analysis phase.
		let review = echoTest.steps[echoTest.analysisStep];
		if (review > 0) {					// >0 means reviewing a test
			let results = echoTest.results[review];
			let name = "test " + review;
			trace2("Analyzing ",name);
			let pulse = echoTest.tones[review];
			let plen = pulse.length;
			let conv = [];					// convolution output
			for (let p=0; p<(results.length-plen); p++) {	// Run the convolution over results
				let sum = 0;
				for (x=0; x<plen; x++) {
					sum += results[p+x]*pulse[x];
				}
				conv.push(sum);				// push each result to output
			}
			let max = 0;
			let edge = 0;
			for (j=0; j<conv.length; j++)			// Find max = edge of pulse
				if (conv[j] > max) {
					max = conv[j];
					edge = j;
				}
			let delay = Math.round((edge*100)/soundcardSampleRate)*10;	// convert result to nearest 10mS
			trace2("Pulse delay is ",delay,"mS");
			echoTest.delays.push(delay.toFixed(0));		// Gather results n mS for each step
//			for (j=0; j<conv.length; j++)			// Normalize output for graphs
//				conv[j] = conv[j]/max;
//			drawWave(results,name,(edge*100/results.length));
		} else {						// All tests have been analyzed. Get conclusions.
			trace2("Reviewing results");
			let counts = [];				// Collate results on mS values
			echoTest.delays.forEach(d => {if (counts[d] == null) counts[d] = 1; else counts[d]++});
			let max = 0;
			let winner = false;
			for (let c in counts) {				// Find most agreed on result (mode)
				if (counts[c] > max) max = counts[c];
				if ((c > 0) && (counts[c] > 5)) {
					trace2("Delay is ",c);
					winner = true;
					echoTest.delay = c;		// Store final delay result
					echoTest.sampleDelay = Math.ceil((echoTest.delay * soundcardSampleRate / 1000)/1024)
					trace2("Sample delay is ",echoTest.sampleDelay);
				}
			}
			if (winner) {					// If delay obtained calculate gain factor
				// Convert delay back to samples as start point for averaging level
				let edge = Math.round(echoTest.delay * soundcardSampleRate / 1000);
				let factors = [];			// Buffer results here
				// for each test <= 1 get avg level from edge for 1024 samples and get factor
				for (let i=0; i<(echoTest.steps.length-1); i++) {
					let t = echoTest.steps[i];
					if (t <= 1) {			// Level tests are <= 1
						let data = echoTest.results[t].slice(edge, (edge+1024));
						let avg = avgValue(data);
						let factor = avg/(t * 0.637);	// Avg mic signal vs avg output signal
						trace2("Test ",echoTest.steps[i]," Factor: ",factor);
						factors.push(factor);	// Store result in buffer
					}
				}
				// Get average factor value
				echoTest.factor = avgValue(factors) * 3; // boost factor to give echo margin
				echoTest.factor = 2;			// Force strong factor always
				trace2("Forced factor is ",echoTest.factor);
			} else {
				trace2("No clear result");		// No agreement, no result
				if (max > 3)
					trace2("It may be worth repeating the test");
			}
			echoTest.running = false;			// Stop test 
		}
		echoTest.analysisStep++;				// Progress to analyze next step
	}
	return outAudio;
}

function drawWave(audio,n,d) {
	let str = '<div id="'+n+'" style="position:absolute; bottom:10%; right:5%; width:80%; height:80%; background-color: #222222; visibility: hidden">'+n;
	let max = 0;
	for (let i=0; i<audio.length;i++) {audio[i] = Math.abs(audio[i]); if (audio[i] > max) max = audio[i];}
	for (let i=4;i<(audio.length-4);i++) {
		let l = (i*100)/audio.length;
		let b = 50 + 50*audio[i];
		str += '<div style="position:absolute; bottom:'+b+'%;left:'+l+'%;width:1px;height:1px;background-color:#66FF33"></div>';
	}
	max = 50 + 50*max;
	str += '<div style="position:absolute; bottom:'+max+'%;left:0%;width:100%;height:1px;background-color:#FF0000">'+max+'</div>';
	str += '<div style="position:absolute; bottom:0%;left:'+d+'%;width:1px;height:100%;background-color:#FF0000"></div>';
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
	let settingsBtn=document.getElementById('settingsBtn');
	settingsBtn.onclick = function () {
		trace2("Settings Button Pressed");
		toggleSettings();
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
var pauseTracing = true;						// Traces are off by default

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
	let aud=document.getElementById('audioDiv');
	if (!pauseTracing) {
		trace("Idle = ", idleState.total, " data in = ", dataInState.total, " audio in/out = ", audioInOutState.total," UI work = ",UIState.total);
		trace("Sent = ",packetsOut," Heard = ",packetsIn," overflows = ",overflows," shortages = ",shortages," RTT = ",rtt.toFixed(1));
		trace("Threshold delay:",echoTest.delay," micIn.peak:",micIn.peak.toFixed(1)," mixOut.peak:",mixOut.peak.toFixed(1)," speaker buff:",spkrBuffer.length," Max Buff:",maxBuffSize);
		trace("Levels of output: ",levelCategories);
	}
//	setNoiseThreshold();						// Set mic noise threshold based on level categories
	if (performer == true) {
		document.getElementById("onair").style.visibility = "visible";
		micFilter1.frequency.value = PerfSampleRate/2.2;	// Change mic filter for performance audio
		micFilter2.frequency.value = 50;
	} else	{
		document.getElementById("onair").style.visibility = "hidden";
		micFilter1.frequency.value = HighFilterFreq		// Return mic filter to normal settings
		micFilter2.frequency.value = LowFilterFreq;
	}
	if (liveShow)
		document.getElementById("ID"+mixOut.channel+"live").style.visibility = "inherit";
	else
		document.getElementById("ID"+mixOut.channel+"live").style.visibility = "hidden";
	let generalStatus = "Green";
	if ((overflows > 1) || (shortages >1) || (rtt >500)) generalStatus = "Orange";
	if (socketConnected == false) generalStatus = "Red";
	setStatusLED("GeneralStatus",generalStatus);
	let upperLimit = SampleRate/PacketSize * 1.2;
	let lowerLimit = SampleRate/PacketSize * 0.8;
	let upStatus = "Green";
	if ((packetsOut < lowerLimit) || (packetsOut > upperLimit)) upStatus = "Orange";
	if (packetsOut < lowerLimit/3) upStatus = "Red";
	setStatusLED("UpStatus",upStatus);
	downStatus = "Green";
	if ((packetsIn < lowerLimit) || (packetsIn > upperLimit)) downStatus = "Orange";
	if (packetsIn < lowerLimit/3) downStatus = "Red";
	setStatusLED("DownStatus",downStatus);
	if ((overflows > 2) || (shortages > 2)) 
		if (maxBuffSize < 20000) maxBuffSize += 100;		// Increase speaker buffer size if we are overflowing or short
	if (maxBuffSize > 6000) maxBuffSize -= 20;			// Steadily drop buffer back to size to compensate
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



// SVG analysis testing...
//
window.addEventListener("load", function(event){
	deriveTree();							
});

function deriveTree() {
	let svg = document.getElementById('venue');
	if (svg == null) return;
	svg = svg.contentDocument;
	let kids = svg.getElementsByClassName("selectable");
	kids = svg.getElementsByTagName("rect"); 
	for (var i=0,len=kids.length;i<len;++i) {
		let kid = kids[i];
		if (kid.nodeType!=1) continue;
		switch(kid.nodeName){
			case 'circle':
			break;
			case 'rect':
				let x = parseFloat(kid.getAttributeNS(null,'x'));
				let y = parseFloat(kid.getAttributeNS(null,'y'));
				let width = parseFloat(kid.getAttributeNS(null,'width'));
				let height = parseFloat(kid.getAttributeNS(null,'height'));
				let ID = kid.getAttributeNS(null,'id');
console.log("Found a rectangle");
console.log(x,y,width,height,ID);
			break;
		}
	}
}

enterState( idleState );
trace("Starting V3.1");
