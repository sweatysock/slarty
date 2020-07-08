

// Network code
//
var socketIO = io();
socketIO.on('connect', function (socket) {
	console.log('socket connected!');
	socketConnected = true;
	socketIO.emit("superHi"); 	// Say hi to the server so it adds us to its list of supervisors
});

socketIO.on('s', function (data) { 
	document.title = data.server;
	document.getElementById("idle").innerHTML = data["idle"];
	document.getElementById("upstream").innerHTML = data["upstream"];
	document.getElementById("downstream").innerHTML = data["downstream"];
	document.getElementById("genMix").innerHTML = data["genMix"];
	document.getElementById("clients").innerHTML = data["clients"];
	document.getElementById("inC").innerHTML = data["in"];
	document.getElementById("out").innerHTML = data["out"];
	document.getElementById("overflows").innerHTML = data["overflows"];
	document.getElementById("shortages").innerHTML = data["shortages"];
	document.getElementById("forcedMixes").innerHTML = data["forcedMixes"];
	document.getElementById("cbs").innerHTML = data["cbs"];
	document.getElementById("pacClass").innerHTML = data["pacClass"];
	document.getElementById("upServer").innerHTML = data["upServer"];
	document.getElementById("upIn").innerHTML = data["upIn"];
	document.getElementById("upOut").innerHTML = data["upOut"];
	document.getElementById("perf").innerHTML = "*"+data["perf"]+"*";
});

socketIO.on('disconnect', function () {
	console.log('socket disconnected!');
	socketConnected = false;
});

// Set up behaviour for UI
//
document.addEventListener('DOMContentLoaded', function(event){
	let muteBtn = document.getElementById('muteBtn');
	let micOpenBtn = document.getElementById('micOpenBtn');
	muteBtn.onclick = ( (e) => {
		socketIO.emit("commands",
		{
			"mute": true,
		});
		muteBtn.style.visibility = "hidden";
		micOpenBtn.style.visibility = "visible";
	});
	micOpenBtn.onclick = ( (e) => {
		socketIO.emit("commands",
		{
			"mute": false,
		});
		muteBtn.style.visibility = "visible";
		micOpenBtn.style.visibility = "hidden";
	});
	let gateDelayEntry = document.getElementById('gateDelayEntry');
	gateDelayEntry.addEventListener("keypress", (e) => {
		if (e.which === 13) {
			socketIO.emit("commands",
			{
				"gateDelay": parseFloat(gateDelayEntry.innerHTML),
			});
			e.preventDefault();
		}
	});
	let toLevelEntry = document.getElementById('toLevelEntry');
	toLevelEntry.addEventListener("keypress", (e) => {
		if (e.which === 13) {
			socketIO.emit("commands",
			{
				"talkoverLevel": parseFloat(toLevelEntry.innerHTML),
			});
			e.preventDefault();
		}
	});
	let perfEntry = document.getElementById('perfEntry');
	perfEntry.addEventListener("keypress", (e) => {
		if (e.which === 13) {
			socketIO.emit("performer",
			{
				"channel": parseFloat(perfEntry.innerHTML),
			});
			e.preventDefault();
		}
	});
	let tholdFactorEntry = document.getElementById('tholdFactorEntry');
	tholdFactorEntry.addEventListener("keypress", (e) => {
		if (e.which === 13) {
			socketIO.emit("commands",
			{
				"tholdFactor": parseFloat(tholdFactorEntry.innerHTML),
			});
			e.preventDefault();
console.log("set threshold factor to ",tholdFactorEntry.innerHTML);
		}
	});
	let noiseThresholdEntry = document.getElementById('noiseThresholdEntry');
	noiseThresholdEntry.addEventListener("keypress", (e) => {
		if (e.which === 13) {
			socketIO.emit("commands",
			{
				"noiseThreshold": parseFloat(noiseThresholdEntry.innerHTML),
			});
			e.preventDefault();
console.log("set noise threshold to ",noiseThresholdEntry.innerHTML);
		}
	});
});


