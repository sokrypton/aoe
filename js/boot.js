// Plain <script src> tags (no defer/async) load and execute strictly in
// order, each one blocking the next — but the Start button's markup exists
// EARLIER in the document than any of them, so the browser can paint it
// (and in some cases let it be clicked) before the code behind it has
// actually finished loading. That's a real race, not just a cosmetic
// concern: clicking Start before, say, init.js has run means
// onStartClicked() doesn't exist yet, or an earlier file (game logic,
// input handlers) is still missing. The button starts disabled in the
// markup; this file is the LAST script in the document, so by the time it
// runs, every game script above it is guaranteed to have already loaded
// and executed (that's what makes plain synchronous script tags useful
// here) — so this is the correct, simplest point to flip it back on.
(function(){
  var btn = document.getElementById('start-game-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Start'; }
})();
