// app.js
// -------- Front-end for Tropic Infusions "Juice Genius" --------

// API base: localhost in dev (both hostnames), same-origin in prod
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const API_BASE = isLocal ? 'http://localhost:3001' : '';

// --- HTTP helper ---
async function apiChat(message) {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // keep session cookie
    body: JSON.stringify({ message })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.details || res.statusText);
  }
  return res.json();
}

// --- TTS cleaning helper: strip emojis, shortcodes, and urls ---
function stripForTTS(text) {
  return String(text)
    // remove URLs
    .replace(/\bhttps?:\/\/\S+/gi, '')
    // remove emoji shortcodes like :pineapple:
    .replace(/:[a-z0-9_+-]+:/gi, '')
    // remove actual emojis (unicode pictographs)
    .replace(/\p{Extended_Pictographic}/gu, '')
    // collapse extra spaces
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// --- DOM ready ---
document.addEventListener('DOMContentLoaded', () => {
  const chatEl   = document.getElementById('chatbox');
  const form     = document.getElementById('composer');
  const input    = document.getElementById('input');
  const micBtn   = document.getElementById('micBtn');
  const statusEl = document.getElementById('modeStatus');
  const vizEl    = document.getElementById('viz');

  // Welcome bubble so the box isn’t empty
  addMsg('assistant', "Hi! I’m here to help. Just share your taste preferences and/or health goals and I’ll recommend a juice.");

  // ----- Chat UI helpers -----
  function addMsg(role, text) {
    const div = document.createElement('div');
    div.className = `bubble ${role}`;
    div.textContent = text;
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

// ----- Send flow (text) -----
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = input.value.trim();
  if (!msg) return;

  addMsg('user', msg);
  input.value = '';
  statusEl && (statusEl.textContent = 'Thinking…');

  // Speak-on-click intro (once)
const INTRO = "Hi! I’m the Juice Genius. Tell me what you like—tart, sweet, spicy, or green—and I’ll recommend a juice.";

const introTargets = [
  document.querySelector('.brand-hero'),
  document.getElementById('micBtn')
];

introTargets.forEach(el => el && el.addEventListener('click', () => {
  if (localStorage.getItem('introPlayed')) return;
  speak(INTRO);                // uses your existing speak() function
  localStorage.setItem('introPlayed', '1');
}, { once: false }));


  try {
    const data = await apiChat(msg);
    const reply = data.reply || '…';
    addMsg('assistant', reply);
    speak(stripForTTS(reply));
  } catch (err) {
    addMsg('assistant', `⚠️ Error: ${err.message || 'Request failed'}`);
    console.error(err);
  } finally {
    statusEl && (statusEl.textContent = 'Ready');
  }
});

  // ----- Voice viz -----
  let vizRAF = null;
  function initViz() {
    if (!vizEl) return;
    if (vizEl.children.length === 0) {
      for (let i = 0; i < 24; i++) {
        const b = document.createElement('div');
        b.className = 'bar';
        vizEl.appendChild(b);
      }
    }
  }
  function startViz(mode) {
    initViz();
    const bars = Array.from(vizEl.children);
    cancelAnimationFrame(vizRAF);
    const speakMode = mode === 'speak';
    (function loop() {
      for (const b of bars) {
        const base = speakMode ? 8 : 4;
        const amp  = speakMode ? 18 : 12;
        b.style.height  = (base + Math.random() * amp) + 'px';
        b.style.opacity = (0.6 + Math.random() * 0.4).toString();
      }
      vizRAF = requestAnimationFrame(loop);
    })();
  }
  function stopViz() {
    cancelAnimationFrame(vizRAF);
    vizRAF = null;
    if (!vizEl) return;
    for (const b of vizEl.children) {
      b.style.height = '6px';
      b.style.opacity = '1';
    }
  }

  // ----- Speech synthesis (assistant talking) -----
  let speaking = false;
  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      speaking = true;
      startViz('speak');
      const u = new SpeechSynthesisUtterance(text.replace(/\n/g, ' '));
      u.rate = 1.02; u.pitch = 1.0; u.volume = 0.95;
      const pref = speechSynthesis.getVoices().find(v =>
        /Samantha|Victoria|Google US English|Hazel|Jenny|Alloy/i.test(v.name)
      );
      if (pref) u.voice = pref;
      u.onend = () => { speaking = false; if (!listening) stopViz(); };
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch {}
  }

  // ----- Speech recognition (hold to speak) -----
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, listening = false;

  if (SR && micBtn) {
    rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;

    const startRec = () => {
      try {
        if (speaking) { speechSynthesis.cancel(); speaking = false; }
        listening = true;
        startViz('listen');
        statusEl && (statusEl.textContent = 'Listening…');
        rec.start();
      } catch {}
    };

    const stopRec = () => {
      listening = false;
      if (!speaking) stopViz();
      statusEl && (statusEl.textContent = 'Processing…');
      try { rec.stop(); } catch {}
    };

    // Press & hold behavior
    micBtn.addEventListener('mousedown', startRec);
    micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRec(); });
    window.addEventListener('mouseup', stopRec);
    window.addEventListener('touchend', stopRec);

    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      if (input) input.placeholder = interim ? ('…' + interim) : 'Tell Juice Genius what you like';
    };

    rec.onerror = () => {
      listening = false;
      if (!speaking) stopViz();
      statusEl && (statusEl.textContent = 'Mic error');
    };

    rec.onend = async () => {
      if (finalText) {
        addMsg('user', finalText);
        const text = finalText;
        finalText = '';
        try {
          const data = await apiChat(text);
          const reply = data.reply || '…';
          addMsg('assistant', reply);
          speak(stripForTTS(reply));
        } catch {
          addMsg('assistant', 'Oops, please try again.');
        }
      }
      if (input) input.placeholder = "Tell Juice Genius what you like (e.g., ‘not too sweet, need energy’)";
      listening = false;
      if (!speaking) stopViz();
      statusEl && (statusEl.textContent = 'Ready');
    };
  } else if (micBtn) {
    // Hide mic if SR not supported
    micBtn.style.display = 'none';
  }

  // ----- Background particles (nice-to-have) -----
  const canvas = document.getElementById('fx');
  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext('2d');
    function size() { canvas.width = innerWidth; canvas.height = innerHeight; }
    size(); addEventListener('resize', size);
    const count = innerWidth < 768 ? 48 : 90;
    const P = Array.from({ length: count }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
      r: Math.random() * 2 + 0.5,
      a: Math.random() * 0.3 + 0.1
    }));
    (function loop() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'lighter';
      for (const p of P) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 6);
        g.addColorStop(0, `rgba(158,255,31,${p.a})`);
        g.addColorStop(1, 'rgba(148,64,221,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 6, 0, Math.PI * 2); ctx.fill();
      }
      requestAnimationFrame(loop);
    })();
  }
});
