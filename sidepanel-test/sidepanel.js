const openedAt = new Date();
document.getElementById('opened-at').textContent = openedAt.toLocaleTimeString();

let clicks = 0;
document.getElementById('click-me').addEventListener('click', () => {
  clicks += 1;
  log(`button clicked (${clicks})`);
});

let ticks = 0;
setInterval(() => {
  ticks += 1;
  document.getElementById('tick').textContent = `Tick: ${ticks}`;
}, 1000);

function log(msg) {
  const el = document.getElementById('log');
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
}

log('panel loaded');
