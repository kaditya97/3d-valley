// Procedural ambience, no audio assets: filtered noise shaped into waterfall
// roar (swells as you approach a fall), high-altitude wind, and rain patter;
// plus synthesized wildlife — songbird chirps near the forest by day, a rare
// red-tailed-hawk cry at altitude, and cricket trills on the valley floor at
// night. Starts on the first user gesture (browser autoplay policy); M toggles.

export class Ambience {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.master = null;
    this.env = { night: 0, rain: 0, snow: 0, forest: 0, agl: 0, windAud: 1 };
    this._nextChirp = 4;
    this._nextHawk = 30;
    this._cricketAt = 0;
    this._t = 0;
  }

  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    // shared looping noise source
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);

    // waterfall: deep rumble + spray hiss
    this.fallGain = ctx.createGain();
    this.fallGain.gain.value = 0;
    const rumble = ctx.createBiquadFilter();
    rumble.type = 'lowpass';
    rumble.frequency.value = 320;
    rumble.Q.value = 0.4;
    const hiss = ctx.createBiquadFilter();
    hiss.type = 'bandpass';
    hiss.frequency.value = 2400;
    hiss.Q.value = 0.5;
    const hissGain = ctx.createGain();
    hissGain.gain.value = 0.35;
    noise.connect(rumble).connect(this.fallGain);
    noise.connect(hiss).connect(hissGain).connect(this.fallGain);
    this.fallGain.connect(this.master);

    // wind: soft band of noise, louder when flying fast or high above ground
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    const wind = ctx.createBiquadFilter();
    wind.type = 'bandpass';
    wind.frequency.value = 700;
    wind.Q.value = 0.3;
    noise.connect(wind).connect(this.windGain).connect(this.master);

    // rain: broadband patter, high-passed so it doesn't muddy the falls
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    const rainHi = ctx.createBiquadFilter();
    rainHi.type = 'highpass';
    rainHi.frequency.value = 600;
    const rainLo = ctx.createBiquadFilter();
    rainLo.type = 'lowpass';
    rainLo.frequency.value = 5200;
    noise.connect(rainHi).connect(rainLo).connect(this.rainGain).connect(this.master);

    // cricket voices: sine through a tight bandpass, gated into trills by the
    // scheduler in update(); two voices at different pitches, panned apart
    this.crickets = [4150, 4550].map((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = 9;
      const gate = ctx.createGain();
      gate.gain.value = 0;
      const pan = ctx.createStereoPanner();
      pan.pan.value = i === 0 ? -0.55 : 0.6;
      osc.connect(bp).connect(gate).connect(pan).connect(this.master);
      osc.start();
      return { gate, next: 0 };
    });

    noise.start();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.1);
    }
    return this.muted;
  }

  // A few quick descending notes, randomly pitched and panned — close enough
  // to a chickadee that the forest feels inhabited.
  _chirp() {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.02;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.master);
    const base = 2600 + Math.random() * 1400;
    const notes = 2 + Math.floor(Math.random() * 3);
    for (let n = 0; n < notes; n++) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const at = t0 + n * (0.1 + Math.random() * 0.07);
      const f = base * (1 - n * 0.08) * (0.97 + Math.random() * 0.06);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, at);
      osc.frequency.exponentialRampToValueAtTime(f * 0.82, at + 0.08);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.045, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
      osc.connect(g).connect(pan);
      osc.start(at);
      osc.stop(at + 0.12);
    }
  }

  // Distant red-tailed hawk: one long downward "keeeer", soft and rare.
  _hawkCry() {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.05;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(2900, t0);
    osc.frequency.exponentialRampToValueAtTime(1500, t0 + 1.3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.022, t0 + 0.08);
    g.gain.setValueAtTime(0.022, t0 + 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.35);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.2 - 0.6;
    osc.connect(lp).connect(g).connect(pan).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + 1.5);
  }

  // fallInfo: nearest waterfall (drop scales loudness); agl: meters above
  // ground; speed: movement m/s; env: {night, rain, snow, forest, windAud}
  update(fallInfo, agl, speed, env) {
    if (env) this.env = { ...this.env, ...env, agl };
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const e = this.env;
    this._t += 0.15; // called on the HUD tick

    let fall = 0;
    if (fallInfo) {
      const reach = 120 + fallInfo.fall.drop * 1.6; // big falls carry further
      fall = Math.min(1, reach / Math.max(fallInfo.d, 25)) ** 2 * 0.5;
    }
    this.fallGain.gain.setTargetAtTime(fall, t, 0.35);

    const wind = (Math.min(1, speed / 600) * 0.12 + Math.min(1, Math.max(0, agl - 60) / 900) * 0.05
                 + (e.windAud - 1) * 0.035) * Math.max(1, e.windAud * 0.7);
    this.windGain.gain.setTargetAtTime(Math.min(wind, 0.3), t, 0.5);

    this.rainGain.gain.setTargetAtTime(e.rain * 0.13, t, 0.8);

    // songbirds: day, near the forest, on the ground side, not raining
    if (this._t > this._nextChirp) {
      this._nextChirp = this._t + 3 + Math.random() * 10;
      if (e.night < 0.35 && e.rain < 0.25 && e.snow < 0.5 && e.forest > 0.12 && agl < 80) this._chirp();
    }
    // a hawk, occasionally, when riding the same air the ravens do
    if (this._t > this._nextHawk) {
      this._nextHawk = this._t + 40 + Math.random() * 70;
      if (e.night < 0.3 && e.rain < 0.2 && agl > 130) this._hawkCry();
    }

    // crickets: valley-floor nights; schedule trills slightly ahead
    const cricketsOn = e.night > 0.5 && agl < 50 && e.rain < 0.3 && e.snow < 0.4;
    for (const c of this.crickets) {
      if (!cricketsOn) continue;
      while (c.next < t + 0.6) {
        const at = Math.max(c.next, t + 0.05);
        for (let p = 0; p < 3; p++) { // a trill: three 30 ms pulses
          const pt = at + p * 0.058;
          c.gate.gain.setTargetAtTime(0.028, pt, 0.006);
          c.gate.gain.setTargetAtTime(0, pt + 0.03, 0.01);
        }
        c.next = at + 0.42 + Math.random() * 0.5;
      }
      if (!this._cricketWasOn) c.next = t + Math.random();
    }
    if (!cricketsOn) for (const c of this.crickets) c.gate.gain.setTargetAtTime(0, t, 0.2);
    this._cricketWasOn = cricketsOn;
  }
}
