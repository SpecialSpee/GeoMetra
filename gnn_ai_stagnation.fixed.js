/* ============================================================================
 *  GnnAI · checkTechStagnation — ИСПРАВЛЕННАЯ ВЕРСИЯ (drop-in)
 * ----------------------------------------------------------------------------
 *  Что было сломано в оригинале:
 *   1. Блок BEACON_SPAM: нет открывающей "{" после if, зато есть закрывающая "}"
 *      -> "}" закрывала саму функцию, дальше код висел вне неё, последняя "}"
 *         объекта становилась лишней => SyntaxError, весь файл не парсился.
 *   2. `const spamPenalty` как тело if без блоков -> SyntaxError
 *      (lexical declaration cannot appear in a single-statement context).
 *   3. `$ {beaconCount}` — пробел между $ и { => интерполяции нет, в лог летит
 *      литерал "$ {beaconCount}".
 *   4. spamPenalty использовалась вне своей области видимости.
 *   5. gameTimeMin = performance.now()/60000 — это время от ЗАГРУЗКИ СТРАНИЦЫ,
 *      а не от старта матча. После рестарта/паузы все тайминги врут.
 *   6. this.lastResourceTotal читался, но НИКОГДА не обновлялся -> проверка
 *      прироста ресурсов мертва.
 *   7. hasBase2 = b.active -> пока Base2 СТРОИТСЯ, ИИ получает штраф за то,
 *      что он уже делает правильную вещь. Главная причина "дёрганья" ИИ.
 *   8. totalArmy = units.length считало ВОРКЕРОВ -> composition-штрафы и
 *      бонусы за разнообразие считались по мусору.
 *   9. Двойной/тройной счёт: no_barracks (2 раза), no_base2 (2 раза),
 *      no_workers (3 раза), turrets_without_army (2 раза).
 *  10. Штрафы росли линейно без предела (-5 * minutesLate каждые 10 с):
 *      к 20-й минуте один только "no_base2" давал -70 за тик и глушил всё
 *      остальное обучение (reward drowning).
 *  11. Все штрафы писались в replay как AIDX.idle -> модель учится
 *      "idle = плохо" вместо "не построил Base2 = плохо" (credit assignment).
 * ==========================================================================*/

/* ── ЧАСТЬ 1. Вставить РЯДОМ с объектом GnnAI (на уровне модуля) ─────────── */

const STAG_CFG = {
  intervalMs: 10000,          // как часто проверяем
  base2Cost: 400,             // ← подставь реальную цену из своего COSTS
  base3Cost: 900,             // ← то же
  richFactor: 2.0,            // "богатый" = запас > 2 цены Base2 (и не меньше 800)
  richFloor: 800,             // твой исходный порог
  rewardScale: 25,            // мягкий клиппинг: scale * tanh(sum / scale)
  caps: { eco: 30, army: 20, tech: 32, tempo: 15, bonus: 18 }, // кап на категорию
  logCooldownMs: 30000,       // не спамить одинаковыми причинами в консоль
};

const stagClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ── ЧАСТЬ 2. Методы. Вставить ВНУТРЬ объекта GnnAI ────────────────────────
 *  Либо просто: Object.assign(GnnAI, GnnAIStagnationMixin);
 *  Новые поля инициализируются лениво, старый init менять не обязательно.
 * ------------------------------------------------------------------------*/
const GnnAIStagnationMixin = {

  /** Честное игровое время в минутах (а не performance.now от загрузки страницы).
   *  Приоритет: игровой_clock -> собственный счётчик от старта матча. */
  gameMinutes: function (now) {
    // Если в движке есть игровой таймер — используй его (укажи единицы!):
    // if (typeof gameState.time === 'number') return gameState.time / 60000; // ms
    // if (typeof gameState.elapsedSec === 'number') return gameState.elapsedSec / 60;
    // ВАЖНО: == null, а не !x — иначе gameStartTime === 0 (falsy) сбрасывается каждый тик
    if (this.gameStartTime == null) this.gameStartTime = now;
    return Math.max(0, (now - this.gameStartTime) / 60000);
  },

  /** Вызывать при старте/рестарте матча — иначе тайминги и вехи поедут. */
  resetStagnation: function (now) {
    this.gameStartTime = now;
    this.lastStagnationCheck = 0;
    this.lastResourceTotal = 0;
    this._stagMilestones = {};
    this._stagLogAt = {};
    this._stagTerminalSent = false;
  },

  checkTechStagnation: function (now) {
    const CFG = STAG_CFG;
    const A = (typeof AIDX !== 'undefined' && AIDX) ? AIDX : {};
    const act = (k) => (A[k] != null ? A[k] : (A.idle != null ? A.idle : 0));

    if (now - (this.lastStagnationCheck || 0) < CFG.intervalMs) return;
    const dtMs = this.lastStagnationCheck ? (now - this.lastStagnationCheck) : CFG.intervalMs;
    this.lastStagnationCheck = now;
    // масштабируем награду по реально прошедшему времени (лаг/свернутая вкладка)
    const dtScale = stagClamp(dtMs / CFG.intervalMs, 0.5, 3);

    if (typeof gameState === 'undefined' || !gameState || gameState.gameOver) return;
    const m = this.metrics && this.metrics();
    if (!m) return;
    const t = this.gameMinutes(now);

    /* --- ledger: категории вместо одной кучи, чтобы капать по отдельности --- */
    const ledger = { eco: 0, army: 0, tech: 0, tempo: 0, bonus: 0 };
    const entries = [];
    const reasons = [];
    const add = (cat, v, reason, action) => {
      ledger[cat] += v;
      entries.push({ cat, v, reason, action });
      reasons.push(reason);
    };

    /* --- юниты: воркеры ОТДЕЛЬНО от армии (фикс #8) --- */
    const aiUnits = gameState.units.filter(u => u.owner === 'ai' && u.health > 0);
    const COMBAT = new Set(['fighter', 'assault', 'elite']);
    const army = aiUnits.filter(u => COMBAT.has(u.type));
    const workers = aiUnits.filter(u => u.type === 'worker');
    const workerCount = workers.length;
    const fighterCount = army.filter(u => u.type === 'fighter').length;
    const assaultCount = army.filter(u => u.type === 'assault').length;
    const eliteCount = army.filter(u => u.type === 'elite').length;
    const totalArmy = army.length;

    /* --- здания: активные И строящиеся (фикс #7) --- */
    const aiB = gameState.buildings.filter(
      b => b.owner === 'ai' && (b.health === undefined || b.health > 0)
    );
    const done = ty => aiB.some(b => b.type === ty && b.active);
    const wip  = ty => aiB.some(b => b.type === ty && !b.active &&
      (b.underConstruction === true || (b.buildProgress || 0) > 0 || (b.progress || 0) > 0));
    const anyWip = aiB.some(b => !b.active);

    const hasBarracks = done('barracks'), barracksWip = wip('barracks');
    const hasBase2 = done('base2'),       base2Wip = wip('base2');
    const hasBase3 = done('base3');
    // не доверяем m.techLevel слепо: считаем из фактических зданий
    const techLevel = hasBase3 ? 3 : hasBase2 ? 2 : (m.techLevel || 1);

    /* --- терминал: ИИ мёртв — не забиваем буфер мусором (фикс #10) --- */
    if (aiB.length === 0 && aiUnits.length === 0 && t > 0.5) {
      if (!this._stagTerminalSent) {
        this._stagTerminalSent = true;
        const s = this.buildGraphState();
        if (s) this.replay.push({
          X: s.X, A_distance: s.A_distance, A_threat: s.A_threat,
          actionIndex: act('idle'), reward: -60, done: true
        });
        console.warn('[GnnAI] 💀 ИИ уничтожен: терминальный штраф -60');
      }
      return;
    }

    /* ══ ЭКОНОМИКА: один штраф вместо трёх пересекающихся ═════════════════ */
    const hasEco = done('warehouse') || done('repairWorkshop');
    if (workerCount === 0 && t > 0.5) {
      const sev = stagClamp((t - 0.5) / 2, 0, 1);       // 0→1 за 2 минуты, дальше не растёт
      add('eco', -(12 + 18 * sev),
          `NO_WORKERS_${t.toFixed(1)}min${hasEco ? '_ECO_BUILDINGS_IDLE' : ''}`,
          act('trainWorker'));
    } else if (workerCount < 3 && t > 3 && hasEco) {
      add('eco', -4, `TOO_FEW_WORKERS_${workerCount}`, act('trainWorker'));
    }

    /* --- доход: считаем и ОБНОВЛЯЕМ базу (фикс #6) --- */
    const res = m.resTotal || 0;
    const prev = this.lastResourceTotal || 0;
    const incomePerMin = dtMs > 0 ? (res - prev) / (dtMs / 60000) : 0;
    this.lastResourceTotal = res;                        // ← раньше этого не было!
    // трата ресурсов на стройку — это ХОРОШО, поэтому не штрафуем при WIP
    if (t > 1.5 && workerCount > 0 && !anyWip && incomePerMin <= 0 && res < CFG.richFloor) {
      add('eco', -6, `ZERO_INCOME_${Math.round(incomePerMin)}/min`, act('buildWarehouse'));
    }

    /* ══ ТЕХ-БЛОК ═══════════════════════════════════════════════════════════
     *  ⬇⬇⬇ ВОТ СЮДА ВСТАВЛЯЕТСЯ RICH_FOOL_PENALTY ⬇⬇⬇
     *  Сразу ПОСЛЕ прогрессивного штрафа за отсутствие Base2 и ДО турелей.
     *  Почему тут: (а) hasBase2/base2Wip/techLevel уже посчитаны выше,
     *  (б) это одна смысловая группа "тех-отставание", (в) её надо капать
     *  вместе с остальным тех-штрафом, иначе двойной счёт убьёт сигнал.
     * ------------------------------------------------------------------- */
    if (t > 3 && !hasBarracks && !barracksWip) {
      const late = Math.min(4, t - 3);
      add('tech', -(3 + 2 * late), `NO_BARRACKS_${late.toFixed(1)}min_late`, act('buildBarracks'));
    }

    const t2Late = (!hasBase2 && !base2Wip && t > 6);
    if (t2Late) {
      const late = Math.min(5, t - 6);                   // сатурация вместо ∞ роста
      add('tech', -(4 + 2.5 * late), `TECH_STAGNATION_T1_${late.toFixed(1)}min_late`, act('buildBase2'));
    }

    // 🔥 НОВЫЙ ШТРАФ: Богатый, но технологически отсталый
    const richThreshold = Math.max(CFG.richFloor, CFG.base2Cost * CFG.richFactor);
    const isRich = res > richThreshold;
    if (isRich && techLevel === 1 && t > 3.0 && !base2Wip) {
      // если Base2 уже строится — штрафа нет (это и есть правильное поведение)
      const over = stagClamp(res / richThreshold, 1, 2);          // 1..2 — чем жирнее, тем больнее
      const threat = (this.strategicMemory && this.strategicMemory.threatLevel) || 0;
      const surviv = threat > 0.7 ? 0.5 : 1.0;                    // под ударом выживание важнее тира
      // если только что получили прогрессивный штраф — усиливаем, а не дублируем
      const base = t2Late ? 12.0 : 25.0;
      add('tech', -base * over * surviv,
          `RICH_FOOL: ${Math.round(res)} рес. (> ${Math.round(richThreshold)}) и Тир-1 на ${t.toFixed(1)} мин — строй Base2!`,
          act('buildBase2'));
    }

    if (t > 12 && !hasBase3 && !wip('base3')) {
      add('tech', -4, 'NO_BASE3_BY_12MIN', act('buildBase3'));
    }

    /* ══ АРМИЯ ═════════════════════════════════════════════════════════════ */
    const threatLevel = (this.strategicMemory && this.strategicMemory.threatLevel) || 0;
    if (threatLevel > 0 && totalArmy === 0 && t > 1.0) {
      add('army', -15, 'PANIC_ZERO_ARMY_UNDER_THREAT', act('trainFighter'));
    }
    const turretCount = aiB.filter(b => b.type && b.type.startsWith('turret') && b.active).length;
    // ОДИН штраф вместо двух ("turrets_but_no_army" + "turrets_without_army")
    if (turretCount >= 3 && totalArmy === 0 && t > 3) {
      add('army', -10, 'PACIFIST_TRAP_TURRETS_NO_ARMY', act('trainFighter'));
    } else if (turretCount > 5 && totalArmy < 3 && t > 5) {
      add('army', -3, `TURTLE_${turretCount}_TURRETS_ARMY_${totalArmy}`, act('trainAssault'));
    }

    if (totalArmy > 15 && t > 5) {
      const fr = fighterCount / totalArmy;
      if (fr > 0.9)      add('army', -12, 'ARMY_90PCT_FIGHTERS', act('trainAssault'));
      else if (fr > 0.8) add('army', -8,  'ARMY_80PCT_FIGHTERS', act('trainAssault'));
    }

    /* ══ ТЕМП / АНТИ-СПАМ (тут были сломанные скобки) ══════════════════════ */
    const beaconCount = aiB.filter(b => b.type === 'beacon' && b.active).length;
    if (beaconCount > 2 && !hasBase2 && !base2Wip && t > 3) {   // ← "{" НА МЕСТЕ
      const spamPenalty = -(5.0 + beaconCount * 2.0);
      add('tempo', spamPenalty,
          `BEACON_SPAM: ${beaconCount} маяков без Base2 — слив ресурсов`,  // ← "${}" без пробела
          act('buildBeacon'));
    }                                                          // ← закрывает if, а не функцию

    /* ══ БОНУСЫ: за результат и за вехи (однократно, не фармятся) ══════════ */
    this._stagMilestones = this._stagMilestones || {};
    const once = (key, v, reason) => {
      if (!this._stagMilestones[key]) { this._stagMilestones[key] = t; add('bonus', v, reason); }
    };
    if (hasBarracks) once('barracks', 6, 'MILESTONE_BARRACKS');
    if (hasBase2)    once('base2', 12, 'MILESTONE_TIER2');
    if (hasBase3)    once('base3', 16, 'MILESTONE_TIER3');
    if (workerCount >= 6) once('eco6', 6, 'MILESTONE_6_WORKERS');

    const uniqueTypes = (fighterCount > 0) + (assaultCount > 0) + (eliteCount > 0);
    if (totalArmy >= 6 && uniqueTypes >= 2 && t > 6) add('bonus', 5, 'DIVERSE_ARMY');
    if (totalArmy >= 9 && uniqueTypes === 3 && t > 8) add('bonus', 8, 'FULL_COMPOSITION');
    if (hasBarracks && hasBase2 && totalArmy > 5 && t > 5) add('bonus', 2, 'BALANCED_DEVELOPMENT');

    /* ══ АГРЕГАЦИЯ: капы по категориям + мягкий клиппинг ═══════════════════ */
    let total = 0;
    for (const k of Object.keys(ledger)) {
      total += stagClamp(ledger[k], -CFG.caps[k], CFG.caps[k]);
    }
    if (Math.abs(total) < 0.5) return;
    const reward = CFG.rewardScale * Math.tanh(total / CFG.rewardScale) * dtScale;

    const s = this.buildGraphState();
    if (!s) return;

    // Кредит-ассайнмент: виним не "idle", а самое дорогое упущенное действие.
    let blameAction = act('idle'), worst = 0;
    for (const e of entries) if (e.v < worst) { worst = e.v; blameAction = e.action; }

    this.replay.push({
      X: s.X, A_distance: s.A_distance, A_threat: s.A_threat,
      actionIndex: blameAction,
      reward,
      done: false,
      // полезно для приоритизированного реплея и дебага:
      shaping: true, reasonMask: ledger
    });

    /* --- лог с анти-спамом --- */
    this._stagLogAt = this._stagLogAt || {};
    const key = reasons.slice().sort().join('|').slice(0, 160);
    if (now - (this._stagLogAt[key] || -1e9) > CFG.logCooldownMs) {
      this._stagLogAt[key] = now;
      const tag = reward > 0 ? '💰 Награда' : '⚠️ Штраф';
      console.log(`[GnnAI] ${tag}: ${reward.toFixed(1)} (raw ${total.toFixed(1)}) → a#${blameAction} :: ${reasons.join(', ')}`);
    }
  },

  /* ── БОНУС: "правильный" способ шейпинга (Ng et al., 1999) ──────────────
   * potential-разница НЕ меняет оптимальную политику, в отличие от ручных
   * штрафов, и не требует угадывать виновное действие.
   * Вызывать на каждом шаге решения: r_total = r_env + shapeReward(prev, cur).
   * -------------------------------------------------------------------- */
  potential: function (m, t) {
    const tech = (m.techLevel || 1);
    return (
      6.0 * Math.log1p(m.workers || 0) +           // экономика (насыщающаяся)
      4.0 * Math.log1p(m.armyValue || 0) +         // армия в "стоимости", а не в штуках
      8.0 * (tech - 1) +                           // тир
      3.0 * Math.log1p(m.incomePerMin || 0) +      // доход
      5.0 * (m.mapControl || 0) +                  // контроль карты 0..1
      4.0 * (m.enemyDamageDealt || 0) / 1000 -     // урон врагу
      4.0 * (m.ownDamageTaken || 0) / 1000
    );
  },

  shapeReward: function (prevM, curM, tPrev, tCur, gamma = 0.99) {
    if (!prevM || !curM) return 0;
    const r = gamma * this.potential(curM, tCur) - this.potential(prevM, tPrev);
    return stagClamp(r, -10, 10);                  // клип ради стабильности TD
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { STAG_CFG, stagClamp, GnnAIStagnationMixin };
}