// ============================================================
// 🔊 SPACE AUDIO MANAGER v3 (Полная озвучка игры)
// ============================================================
class SpaceAudioManager {
    constructor() {
        this.ctx = null;
        this.isMuted = false;
        // Каналы громкости (можно крутить под себя)
        this.channels = {
            laser: 0.35, artillery: 0.7, melee: 0.6,
            fighter: 0.25, assault_mg: 0.4, assault_rocket: 0.5,
            turret: 0.5, turret2: 0.5, turret3: 0.55,
            building: 0.5, resource: 0.3, repair: 0.3,
            explosion: 0.8, ui: 0.3
        };
        // Защита от спама (мс) — критично для пулемётов и лазеров!
        this.minInterval = {
            laser: 80, artillery: 500, melee: 150,
            fighter: 100, assault_mg: 120, assault_rocket: 400,
            turret: 200, turret2: 400, turret3: 800,
            building: 100, resource: 80, repair: 300,
            explosion: 400, ui: 100
        };
        this.lastPlayed = new Map();
        this.noiseBuffer = null;
    }

    init() {
        if (!this.ctx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContext();
            this._generateNoiseBuffer();
            console.log("🔊 Аудиосвязь установлена (Ударный синтез v3)");
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    _generateNoiseBuffer() {
        const bufferSize = this.ctx.sampleRate * 2;
        this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = this.noiseBuffer.getChannelData(0);
        let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
        for (let i = 0; i < bufferSize; i++) {
            const white = Math.random() * 2 - 1;
            b0 = 0.99886*b0 + white*0.0555179;
            b1 = 0.99332*b1 + white*0.0750759;
            b2 = 0.96900*b2 + white*0.1538520;
            b3 = 0.86650*b3 + white*0.3104856;
            b4 = 0.55000*b4 + white*0.5329522;
            b5 = -0.7616*b5 - white*0.0168980;
            data[i] = (b0+b1+b2+b3+b4+b5+b6+white*0.5362)*0.11;
            b6 = white*0.115926;
        }
    }

    canPlay(id) {
        const now = performance.now();
        const last = this.lastPlayed.get(id) || 0;
        const minInt = this.minInterval[id] || 100;
        if (now - last < minInt) return false;
        this.lastPlayed.set(id, now);
        return true;
    }

    // === УНИВЕРСАЛЬНЫЙ ПРОИГРЫВАТЕЛЬ ===
    play(type, pitch = 100, duration = 0.2, volume = 0.5) {
        if (this.isMuted || !this.ctx || !this.canPlay(type)) return;
        const t = this.ctx.currentTime;
        const channelVol = this.channels[type] !== undefined ? this.channels[type] : 1;
        const masterGain = this.ctx.createGain();
        masterGain.gain.value = volume * channelVol;
        masterGain.connect(this.ctx.destination);

        // --- БОЕВЫЕ ЗВУКИ ---
        if (type === 'artillery' || type === 'explosion') {
            this._playImpact(t, masterGain, pitch, duration, type === 'explosion' ? 1000 : 500);
        }
        else if (type === 'melee' || type === 'assault_mg') {
            // Резкий короткий хлопок (дробовик / пулемёт)
            this._playNoiseBurst(t, masterGain, type === 'melee' ? 1500 : 2500, 0.12, 0.8);
        }
        else if (type === 'laser' || type === 'turret3') {
            // Энергетический треск (лазер элиты / лазерная турель)
            this._playLaserZap(t, masterGain, type === 'turret3' ? 800 : 600, type === 'turret3' ? 0.25 : 0.15);
        }
        else if (type === 'fighter') {
            // Короткий "пик" бластера файтера
            const osc = this.ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.setValueAtTime(900 + Math.random()*100, t);
            osc.frequency.exponentialRampToValueAtTime(400, t + 0.08);
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0.3, t);
            g.gain.exponentialRampToValueAtTime(0.01, t + 0.08);
            osc.connect(g); g.connect(masterGain);
            osc.start(t); osc.stop(t + 0.08);
        }
        else if (type === 'assault_rocket') {
            // Свист ракеты (восходящий тон + шумовой выхлоп)
            const osc = this.ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(200, t);
            osc.frequency.exponentialRampToValueAtTime(1200, t + 0.3);
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0.4, t);
            g.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
            osc.connect(g); g.connect(masterGain);
            osc.start(t); osc.stop(t + 0.3);
            // Шумовой выхлоп
            this._playNoiseBurst(t, masterGain, 800, 0.25, 0.4);
        }
        else if (type === 'turret') {
            // Тяжёлый выстрел обычной турели
            this._playImpact(t, masterGain, 120, 0.25, 400);
        }
        else if (type === 'turret2') {
            // Ракетная турель — свист + бас
            const osc = this.ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(150, t);
            osc.frequency.exponentialRampToValueAtTime(900, t + 0.25);
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0.4, t);
            g.gain.exponentialRampToValueAtTime(0.01, t + 0.25);
            osc.connect(g); g.connect(masterGain);
            osc.start(t); osc.stop(t + 0.25);
        }
        // --- МИРНЫЕ ЗВУКИ ---
        else if (type === 'building') {
            // Звук появления здания: восходящий "чпок" с аккордом
            const osc1 = this.ctx.createOscillator();
            const osc2 = this.ctx.createOscillator();
            osc1.type = 'sine'; osc2.type = 'triangle';
            osc1.frequency.setValueAtTime(200, t);
            osc1.frequency.exponentialRampToValueAtTime(600, t + 0.4);
            osc2.frequency.setValueAtTime(300, t);
            osc2.frequency.exponentialRampToValueAtTime(900, t + 0.4);
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0.01, t);
            g.gain.linearRampToValueAtTime(0.5, t + 0.05);
            g.gain.exponentialRampToValueAtTime(0.01, t + 0.5);
            osc1.connect(g); osc2.connect(g); g.connect(masterGain);
            osc1.start(t); osc2.start(t);
            osc1.stop(t + 0.5); osc2.stop(t + 0.5);
        }
        else if (type === 'resource') {
            // Хрустальный "дзынь" сбора ресурса
            const osc = this.ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(1200 + Math.random()*200, t);
            osc.frequency.exponentialRampToValueAtTime(1800, t + 0.15);
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0.3, t);
            g.gain.exponentialRampToValueAtTime(0.01, t + 0.2);
            osc.connect(g); g.connect(masterGain);
            osc.start(t); osc.stop(t + 0.2);
            // Добавим обертон для "хрусталя"
            const osc2 = this.ctx.createOscillator();
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(2400, t);
            const g2 = this.ctx.createGain();
            g2.gain.setValueAtTime(0.15, t);
            g2.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
            osc2.connect(g2); g2.connect(masterGain);
            osc2.start(t); osc2.stop(t + 0.15);
        }
        else if (type === 'repair') {
            // Искра ремонта: короткий "вжик" с шипением
            this._playNoiseBurst(t, masterGain, 3000, 0.1, 0.4);
            const osc = this.ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(800, t);
            osc.frequency.exponentialRampToValueAtTime(1500, t + 0.1);
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0.25, t);
            g.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
            osc.connect(g); g.connect(masterGain);
            osc.start(t); osc.stop(t + 0.1);
        }
    }

    // === ВСПОМОГАТЕЛЬНЫЕ СИНТЕЗАТОРЫ ===
    _playImpact(t, masterGain, pitch, duration, filterFreq) {
        // Саб-бас удар
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(pitch, t);
        osc.frequency.exponentialRampToValueAtTime(pitch*0.1, t + duration);
        const og = this.ctx.createGain();
        og.gain.setValueAtTime(0.9, t);
        og.gain.exponentialRampToValueAtTime(0.01, t + duration);
        osc.connect(og); og.connect(masterGain);
        osc.start(t); osc.stop(t + duration);
        // Ударный шум
        this._playNoiseBurst(t, masterGain, filterFreq, duration*0.8, 0.7);
    }

    _playNoiseBurst(t, masterGain, filterFreq, duration, vol) {
        const noise = this.ctx.createBufferSource();
        noise.buffer = this.noiseBuffer;
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(filterFreq, t);
        filter.frequency.exponentialRampToValueAtTime(100, t + duration);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.01, t + duration);
        noise.connect(filter); filter.connect(g); g.connect(masterGain);
        noise.start(t); noise.stop(t + duration);
    }

    _playLaserZap(t, masterGain, pitch, duration) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(pitch, t);
        osc.frequency.exponentialRampToValueAtTime(100, t + duration);
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(4000, t);
        filter.frequency.exponentialRampToValueAtTime(400, t + duration);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.4, t);
        g.gain.exponentialRampToValueAtTime(0.01, t + duration);
        osc.connect(filter); filter.connect(g); g.connect(masterGain);
        osc.start(t); osc.stop(t + duration);
    }
}

const spaceAudio = new SpaceAudioManager();
document.addEventListener('click', () => spaceAudio.init(), { once: true });
document.addEventListener('keydown', () => spaceAudio.init(), { once: true });