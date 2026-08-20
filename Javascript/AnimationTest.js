const GIF_LOOP_DURATION_MS = 4080;
const FINAL_DISPLAY_DURATION_MS = 4000;
const MAX_QUEUE_LENGTH = 100;
const SOCKET_RECONNECT_DELAY_MS = 1000;
const MAX_SOCKET_RECONNECT_DELAY_MS = 10000;
const CHAT_MESSAGES = ["kwik", "kwek", "kwak"];

const animationContainer = document.querySelector("#animation-container");
const animatedElement = document.querySelector("#animated-element");
const finalState = document.querySelector("#final-state");
const finalImage = finalState.querySelector("img");
const chatText = document.querySelector("#chat-text");
const animationSource = animatedElement.getAttribute("data-src");
let queueLength = 0;
let cycleActive = false;
let reconnectDelay = SOCKET_RECONNECT_DELAY_MS;
let reconnectTimer;

function delay(duration) {
	return new Promise((resolve) => window.setTimeout(resolve, duration));
}

function imageReady(image) {
	return new Promise((resolve, reject) => {
		if (image.complete) {
			if (image.naturalWidth > 0) {
				resolve();
			} else {
				reject(new Error(`Unable to load image: ${image.src}`));
			}
			return;
		}

		image.addEventListener("load", resolve, { once: true });
		image.addEventListener("error", () => reject(new Error(`Unable to load image: ${image.src}`)), { once: true });
	});
}

async function resetAnimation() {
	animationContainer.hidden = false;
	finalState.hidden = true;
	chatText.textContent = "";
	animatedElement.hidden = false;
	animatedElement.removeAttribute("src");
	await delay(0);
	animatedElement.setAttribute("src", animationSource);
	await imageReady(animatedElement);
}

async function runAnimationCycle() {
	try {
		await imageReady(finalImage);
		await resetAnimation();

		await delay(GIF_LOOP_DURATION_MS);

		animatedElement.hidden = true;
		finalState.hidden = false;
		chatText.textContent = CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)];
		await delay(FINAL_DISPLAY_DURATION_MS);

		animationContainer.hidden = true;
	} catch {
		await delay(SOCKET_RECONNECT_DELAY_MS);
		return runAnimationCycle();
	}
}

async function processAnimations() {
	if (cycleActive) {
		return;
	}

	cycleActive = true;
	await runAnimationCycle();

	while (queueLength > 0) {
		queueLength -= 1;
		await runAnimationCycle();
	}

	cycleActive = false;
}

function queueAnimation() {
	if (!cycleActive) {
		processAnimations();
		return;
	}
	if (queueLength < MAX_QUEUE_LENGTH) {
		queueLength += 1;
	}

	processAnimations();
}

function connectToServer() {
	if (window.location.protocol === "file:") {
		return;
	}

	const socketProtocol = window.location.protocol === "https:" ? "wss" : "ws";
	const socket = new WebSocket(`${socketProtocol}://${window.location.host}/events`);

	socket.addEventListener("open", () => {
		reconnectDelay = SOCKET_RECONNECT_DELAY_MS;
	});
	socket.addEventListener("message", (event) => {
		try {
			const message = JSON.parse(event.data);
			if (message.type === "chest") {
				queueAnimation();
			}
		} catch {}
	});
	socket.addEventListener("error", () => socket.close());
	socket.addEventListener("close", () => {
		window.clearTimeout(reconnectTimer);
		reconnectTimer = window.setTimeout(connectToServer, reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, MAX_SOCKET_RECONNECT_DELAY_MS);
	});
}

connectToServer();