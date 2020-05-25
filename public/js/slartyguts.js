

// Network code
//
var socketIO = io();
socketIO.on('connect', function (socket) {
	console.log('socket connected!');
	socketConnected = true;
	socketIO.emit("superHi"); 	// Say hi to the server so it adds us to its list of supervisors

	socketIO.on('s', function (data) { 
		document.getElementById("idle").innerHTML = data["idle"];
		document.getElementById("upstream").innerHTML = data["upstream"];
		document.getElementById("downstream").innerHTML = data["downstream"];
		document.getElementById("genMix").innerHTML = data["genMix"];
		document.getElementById("clients").innerHTML = data["clients"];
		document.getElementById("inC").innerHTML = data["in"];
		document.getElementById("out").innerHTML = data["out"];
		document.getElementById("upShortages").innerHTML = data["upShort"];
		document.getElementById("upOverflows").innerHTML = data["upOver"];
		document.getElementById("overflows").innerHTML = data["overflows"];
		document.getElementById("shortages").innerHTML = data["shortages"];
		document.getElementById("forcedMixes").innerHTML = data["forcedMixes"];
		document.getElementById("cbs").innerHTML = data["cbs"];
		document.getElementById("pacClass").innerHTML = data["pacClass"];
		document.getElementById("upServer").innerHTML = data["upServer"];
		document.getElementById("upIn").innerHTML = data["upIn"];
		document.getElementById("upOut").innerHTML = data["upOut"];
	});
});

socketIO.on('disconnect', function () {
	console.log('socket disconnected!');
	socketConnected = false;
});

// Set up behaviour for UI
//
document.addEventListener('DOMContentLoaded', function(event){
	var upServer = document.getElementById('upServer');
	upServer.textContent = "no upstream server";
	upServer.addEventListener("keypress", (e) => {
		if (e.which === 13) {
			console.log("new server is ",upServer.innerHTML);
			socketIO.emit("nus",
			{
				"upstreamServer": upServer.innerHTML,
			});
			e.preventDefault();
		}
	});
});


