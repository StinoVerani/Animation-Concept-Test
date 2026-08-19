const GIF_LOOP_DURATION_MS = 4080;
const CHAT_MESSAGES = ["kwik", "kwek", "kwak"];

const animatedElement = document.querySelector("#animated-element");
const finalState = document.querySelector("#final-state");
const chatText = document.querySelector("#chat-text");

function showFinalState() {
	animatedElement.remove();
	finalState.hidden = false;
	chatText.textContent = CHAT_MESSAGES[Math.floor(Math.random() * CHAT_MESSAGES.length)];
}

window.setTimeout(showFinalState, GIF_LOOP_DURATION_MS);