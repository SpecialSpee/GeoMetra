// ============================================================
// 04-decisions.js — Решения: decide, execute, validActionMask,
//                    sampleMasked, findBuildPos, tryBuildSpecific
// ============================================================
"use strict";

Object.assign(window.GnnAI, {

  // === Разделение армии на группы для фланговой атаки ===
  splitArmyIntoGroups: function(freeUnits, numGroups = 2) {
    if (freeUnits.length <= numGroups) return freeUnits.map(u => [u]);
    const sorted = [...freeUnits].sort((a, b) => a.x - b.x);
    const groups = Array.from({ length: numGroups }, () => []);
    sorted.forEach((unit, idx) => groups[idx % numGroups].push(unit));
    return groups;
  },

  // === Принятие решения ===
  decide: function () {
    const state = this.buildGraphState();
    if (!state) return;
    const now = performance.now();
    const pred = this.predictData(state);
    if (!pred) return;
    const logitsData = pred.logits;
    const mask = this.validActionMask();
    const temperature = this.bcActive ? 1.5 : 1.0;
    let chosenIndex = this.sampleMasked(logitsData, mask, temperature);

    let proposedAction = G_ACTIONS[chosenIndex];
    let finalActionIndex = chosenIndex;
    let finalAction = proposedAction;

    // Мягкое подавление тактик при занятости армии
    const tacticalIndices = ["tactic_all_in","tactic_harass","tactic_push","tactic_defend"]
      .map(a => this._AIDX[a]).filter(i => i !== undefined);
    const busyUnits = gameState.units.filter(u =>
      u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) &&
      u.health > 0 && u.missionLog
    ).length;
    const totalArmy = gameState.units.filter(u =>
      u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0
    ).length;
    const busyRatio = totalArmy > 0 ? busyUnits / totalArmy : 0;

    if (busyRatio > 0.5) {
      const suppressLogits = logitsData.slice();
      for (const idx of tacticalIndices) suppressLogits[idx] -= 2.0 * busyRatio;
      if (this.lastStrategicAction) {
        const lastIdx = this._AIDX[this.lastStrategicAction];
        if (lastIdx !== undefined) {
          const timeSince = now - (this.lastStrategicChangeTime || 0);
          if (timeSince < (CFG.MIN_COMMIT_MS || 5000)) suppressLogits[lastIdx] -= 1.5;
        }
      }
      chosenIndex = this.sampleMasked(suppressLogits, mask, temperature);
      proposedAction = G_ACTIONS[chosenIndex];
      finalActionIndex = chosenIndex;
      finalAction = proposedAction;
    }

    const isStrategic = ["tactic_all_in","tactic_harass","tactic_push","tactic_defend","build_base2","build_barracks"].includes(proposedAction);
    if (isStrategic) {
      this.lastStrategicChangeTime = now;
      this.lastStrategicAction = proposedAction;
    }

    const metrics = this.metrics();
    const executed = this.execute(finalAction, finalActionIndex, state);
    if (!executed) {
      //console.warn(`[DEBUG AI] ⚠️ Действие '${finalAction}' ЗАПРОШЕНО, но НЕ ВЫПОЛНЕНО! Ресурсы:`, JSON.stringify(gameState.aiResources));
    } else {
      //console.log(`[DEBUG AI] ✅ Действие '${finalAction}' успешно выполнено.`);
    }

    this.pending.push({
      time: now,
      state: { X: state.X, A_distance: state.A_distance, A_threat: state.A_threat },
      action: finalAction,
      actionIndex: finalActionIndex,
      executed: !!executed,
      executedType: typeof executed === 'string' ? executed : null,
      before: metrics,
      logProb: 0,
      value: 0
    });
    if (this.pending.length > 30) this.pending.shift();
    this.lastState = state;
    this.lastAction = finalAction;
  },

  // === Обработка pending-действий ===
  evaluatePending: function (now) {
    if (!this.pending.length) return;
    const current = this.metrics();
    const keep = [];
    for (const p of this.pending) {
      const missionEntry = this.missionCache.find(m => m.action === p.action && !m.resolved);
      if (missionEntry) { keep.push(p); continue; }
      const reward = this.reward(p, current);
      if (Math.abs(reward) > 0.1) {
        this.replay.push({
          X: p.state.X, A_distance: p.state.A_distance, A_threat: p.state.A_threat,
          actionIndex: p.actionIndex, reward
        });
      }
    }
    this.pending = keep;
  },

  // === Награда за HP базы ===
  reward: function (p, after) {
    if (!after.playerAlive) return 500.0;
    if (after.baseHp <= 0) return -500.0;
    const beforeHp = p.before && typeof p.before.baseHp === 'number' ? p.before.baseHp : 1.0;
    const currentHp = typeof after.baseHp === 'number' ? after.baseHp : 0;
    const delta = (currentHp - beforeHp) * 20.0;
    return isFinite(delta) ? delta : 0.0;
  },

  // === Маска доступных действий ===
  validActionMask: function () {
    const mask = new Array(G_ACTIONS.length).fill(0);
    const res = gameState.aiResources;
    if (!res) { mask[this._AIDX.idle] = 1; return mask; }
    const m = this.metrics();
    const can = (costObj) => {
      if (!costObj) return false;
      return (res.gold || 0) >= (costObj.gold || 0) &&
             (res.silicon || 0) >= (costObj.silicon || 0) &&
             (res.plasma || 0) >= (costObj.plasma || 0);
    };
    const getCount = (type) => {
      const built = gameState.buildings.filter(b => b.owner === "ai" && b.type === type && b.health > 0).length;
      const queued = (window.buildQueue || []).filter(q => q.type === type).length;
      return built + queued;
    };
    const has = (type) => gameState.buildings.some(b => b.owner === "ai" && b.type === type && b.active && b.health > 0);

    const warehouses  = getCount("warehouse");
    const workshops   = getCount("repairWorkshop");
    const barracks    = getCount("barracks");
    const base2       = getCount("base2");
    const barracks2   = getCount("barracks2");
    const base3       = getCount("base3");
    const barracks3   = getCount("barracks3");
    const beacons     = getCount("beacon");
    const woundedUnits = gameState.units.filter(u => u.owner === "ai" && u.health > 0 && u.health < u.maxHealth * 0.7).length;
    const totalWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
    const neededWorkers = warehouses * 3;
    const isEconomyStable = m.aiArmy >= 2 || warehouses < 3;

    mask[this._AIDX.idle] = 1;

    // Уровень 0: Экономика
    if (can(WAREHOUSE_COST) && isEconomyStable && totalWorkers >= neededWorkers) mask[this._AIDX.build_warehouse] = 1;
    const hasWarehouseWithSpace = gameState.buildings.some(b =>
      b.owner === "ai" && b.type === "warehouse" && b.active && (b.workers || 0) < (b.maxDeliveryWorkers || 5)
    );
    if (hasWarehouseWithSpace && can(WORKER_COST)) mask[this._AIDX.hireWorker] = 1;
    if (warehouses >= 1 && can(REPAIR_WORKSHOP_COST) && (workshops < 2 || woundedUnits > 3)) mask[this._AIDX.build_repair] = 1;
    const hasWorkshopWithSpace = gameState.buildings.some(b =>
      b.owner === "ai" && b.type === "repairWorkshop" && b.active && (b.repairman || 0) < (b.capacity || 3)
    );
    if (hasWorkshopWithSpace && can(REPAIRMAN_COST)) mask[this._AIDX.hireRepairman] = 1;

    // Уровень 1: Казарма 1
    const hasWarehouse = has("warehouse");
    const hasWorkshop = has("repairWorkshop");
    if (hasWarehouse && hasWorkshop && barracks === 0 && can(BARRACKS_COST)) mask[this._AIDX.build_barracks] = 1;

    const hasBarracksBuilt = has("barracks");
    if (hasBarracksBuilt) {
      const activeTurrets = getCount("turret");
      const maxAllowedTurrets = (beacons + 1) * 3;
      if (activeTurrets < maxAllowedTurrets && can(TURRET_COST)) mask[this._AIDX.build_turret1] = 1;

      const hasTurret = has("turret");
      if (hasTurret && can(BEACON_COST)) {
        const orphan = gameState.buildings.some(b =>
          b.owner === "ai" && b.type === "beacon" && b.active &&
          !gameState.buildings.some(w => w.owner === "ai" && w.type === "warehouse" && Math.hypot(w.x - b.x, w.y - b.y) < 250)
        );
        const hasTarget = this.findBestResourceCluster() !== null;
        if (!orphan && hasTarget && beacons < 4) mask[this._AIDX.build_beacon] = 1;
      }
      if (base2 === 0 && can(BASE2_COST)) mask[this._AIDX.build_base2] = 1;
      if (can(FIGHTER_COST)) mask[this._AIDX.hireFighter] = 1;
    }

    // Уровень 2: База 2 → Казарма 2 + Турель 2
    const hasBase2 = has("base2");
    if (hasBase2) {
      if (barracks2 === 0 && can(BARRACKS2_COST)) mask[this._AIDX.build_barracks2] = 1;
      const activeTurrets2 = getCount("turret2");
      if (activeTurrets2 < (beacons + 1) * 2 && can(TURRET2_COST)) mask[this._AIDX.build_turret2] = 1;
      if (has("barracks2") && can(ASSAULT_COST)) mask[this._AIDX.hireAssault] = 1;
    }

    // Уровень 3: Тир 3
    const hasBarracks2Built = has("barracks2");
    if (hasBarracks2Built) {
      if (base3 === 0 && can(BASE3_COST)) mask[this._AIDX.build_base3] = 1;
      const hasBase3 = has("base3");
      if (hasBase3) {
        if (barracks3 === 0 && can(BARRACKS3_COST)) mask[this._AIDX.build_barracks3] = 1;
        const activeTurrets3 = getCount("turret3");
        if (activeTurrets3 < (beacons + 1) * 2 && can(TURRET3_COST)) mask[this._AIDX.build_turret3] = 1;
        if (has("barracks3") && can(ELITE_COST)) mask[this._AIDX.hireElite] = 1;
      }
    }

    // Тактики
    const armySize = gameState.units.filter(u =>
      u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0
    ).length;
    if (armySize >= 2) {
      mask[this._AIDX.defend] = 1;
      mask[this._AIDX.strike_weak] = 1;
      mask[this._AIDX.focus_fire] = 1;
      mask[this._AIDX.retreat_regroup] = 1;
      mask[this._AIDX.flank_attack] = 1;
      mask[this._AIDX.harass_economy] = 1;
      mask[this._AIDX.all_in_base] = 1;
    }

    const hasAnyAffordableAction = mask.some((v, i) => v === 1 && i !== this._AIDX.idle);
    mask[this._AIDX.idle] = hasAnyAffordableAction ? 0 : 1;
    return mask;
  },

  // === Сэмплирование с маской ===
  sampleMasked: function (logits, mask, temperature = 1.0) {
    const maskedLogits = logits.map((v, i) => mask[i] === 1 ? v / temperature : -1e9);
    const maxLogit = Math.max(...maskedLogits);
    const expLogits = maskedLogits.map(v => Math.exp(v - maxLogit));
    const sumExp = expLogits.reduce((a, b) => a + b, 0) || 1;
    const probs = expLogits.map(v => v / sumExp);
    let r = Math.random();
    for (let i = 0; i < probs.length; i++) {
      r -= probs[i];
      if (r <= 0) return i;
    }
    return probs.length - 1;
  },

  // === Выполнение действия ===
  execute: function (action, actionIndex, state) {
    const now = performance.now();
    
    // === ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ: Проверка "блокировки" юнита ===
    // Юнит игнорирует новые макро-приказы, если он уже выполняет задачу < 6 сек,
    // ИЛИ если его HP критически низкое (< 20%), чтобы позволить экстренное отступление.
    const isUnitAvailable = (u) => {
      if (u.health <= 0) return false;
      if (u.health < u.maxHealth * 0.2) return true; // Экстренный случай: разрешаем прервать задачу для спасения
      if (!u.missionLog) return true;
      return (now - u.missionLog.startTime) > 6000; // 6 секунд "неприкосновенности"
    };

    const tacticalActions = ["strike_weak","focus_fire","retreat_regroup","flank_attack",
      "harass_economy","all_in_base","defend",
      "tactic_all_in","tactic_harass","tactic_push","tactic_defend"];

    if (tacticalActions.includes(action)) {
      const busyUnits = gameState.units.filter(u =>
        u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) &&
        u.health > 0 && u.missionLog
      );
      const totalArmy = gameState.units.filter(u =>
        u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0
      ).length;
      if (totalArmy > 0) {
        const busyRatio = busyUnits.length / totalArmy;
        if (busyRatio > 0.5) {
          const spamPenalty = -15.0 * busyRatio;
          this.replay.push({
            X: state.X, A_distance: state.A_distance, A_threat: state.A_threat,
            actionIndex: actionIndex, reward: spamPenalty
          });
          //console.warn(`[GnnAI] ⚠️ Спам-тактика '${action}': ${Math.round(busyRatio*100)}% армии занята → штраф ${spamPenalty.toFixed(2)}`);
        }
        const recentSame = this.missionCache.filter(m => !m.resolved && m.action === action).length;
        if (recentSame > 0) {
          const repeatPenalty = -15.0 * recentSame;
          this.replay.push({
            X: state.X, A_distance: state.A_distance, A_threat: state.A_threat,
            actionIndex: actionIndex, reward: repeatPenalty
          });
          //console.warn(`[GnnAI] 🔁 Повтор '${action}' (${recentSame}x в полёте) → штраф ${repeatPenalty.toFixed(2)}`);
        }
      }
    }

    const activeAttacks = this.missionCache.filter(m => !m.resolved && m.intent.type === "attack").length;
    if (action.startsWith("attack") && activeAttacks >= 3) {
      this.replay.push({
        X: state.X, A_distance: state.A_distance, A_threat: state.A_threat,
        actionIndex: actionIndex, reward: -5.5
      });
      //console.warn(`[GnnAI] ⚠️ Уже ${activeAttacks} атак в полёте — мягкий штраф`);
    }

    try {
      // DEFEND (ИСПРАВЛЕНО: добавлена проверка времени последней команды)
      if (action === "defend") {
        const freeUnits = gameState.units.filter(u => 
          u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0 && 
          (!u.commandQueue || u.commandQueue.length === 0) &&
          (!u.missionLog || (now - u.missionLog.startTime > 8000)) // Не трогать тех, кому команду дали < 8 сек назад
        );
        if (freeUnits.length === 0) return false;
        const anchor = this.threatAnchor() || aiBase;
        const defenderIds = freeUnits.map(u => u.id);
        freeUnits.forEach(u => {
          u.defending = true;
          u.commandQueue = [{ type: "move", x: anchor.x + (Math.random() - 0.5) * 150, y: anchor.y + (Math.random() - 0.5) * 150 }];
        });
        this.registerAction(action, state, { type: "defend", anchor: anchor.id || "aiBase", units: defenderIds.length, unitIds: defenderIds }, actionIndex);
        return true;
      }

      // TACTIC_*
      if (action.startsWith("tactic_")) {
        const freeUnits = gameState.units.filter(u =>
          u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && isUnitAvailable(u)
        );
        if (freeUnits.length === 0) {
          this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -1.0 });
          return false;
        }
        
        let target = null;
        let forcePercentage = 0.5;
        if (action === "tactic_all_in") {
          target = gameState.buildings.find(b => b.owner === "player" && b.type === "base") || gameState.buildings.find(b => b.owner === "player" && b.health > 0);
          forcePercentage = 0.90;
        } else if (action === "tactic_harass") {
          const vulnerable = [...gameState.units.filter(u => u.owner === "player" && u.type === "worker"),
            ...gameState.buildings.filter(b => b.owner === "player" && (b.type === "warehouse" || b.type === "repairWorkshop"))];
          target = vulnerable.length > 0 ? vulnerable[0] : gameState.buildings.find(b => b.owner === "player" && b.health > 0);
          forcePercentage = 0.30;
        } else if (action === "tactic_push") {
          const enemies = [...gameState.units.filter(u => u.owner === "player" && u.health > 0), ...gameState.buildings.filter(b => b.owner === "player" && b.health > 0)];
          target = enemies.reduce((best, o) => Math.hypot(o.x - aiBase.x, o.y - aiBase.y) < Math.hypot(best.x - aiBase.x, best.y - aiBase.y) ? o : best, enemies[0]);
          forcePercentage = 0.60;
        } else if (action === "tactic_defend") {
          const threats = gameState.units.filter(u => u.owner === "player" && u.health > 0);
          target = threats.reduce((closest, u) => Math.hypot(u.x - aiBase.x, u.y - aiBase.y) < Math.hypot(closest.x - aiBase.x, closest.y - aiBase.y) ? u : closest, {x: aiBase.x, y: aiBase.y, health: 9999});
          forcePercentage = 0.80;
        }
        
        if (!target || target.health <= 0) {
          // Динамический поиск альтернативы, если главная цель мертва
          target = gameState.units.find(u => u.owner === "player" && u.health > 0) || gameState.buildings.find(b => b.owner === "player" && b.health > 0);
          if (!target) return false;
        }

        freeUnits.sort((a, b) => {
          if (action === "tactic_harass") return (a.type === "fighter" ? -1 : 1);
          return 0;
        });
        
        const attackersCount = Math.max(1, Math.ceil(freeUnits.length * forcePercentage));
        const attackers = freeUnits.slice(0, attackersCount);
        const attackerIds = attackers.map(u => u.id);
        
        attackers.forEach(u => {
          const physicalTarget = (target.obj && target.obj.units) ? target.obj.units[0] : target;
          u.commandQueue = [
            { type: "move", x: target.x + (Math.random()-0.5)*40, y: target.y + (Math.random()-0.5)*40 }, // Небольшой разброс, чтобы не слипаться
            { type: "attack", target: physicalTarget }
          ];
        });
        
        this.registerAction(action, state, {
          type: "attack", tactic: action,
          targetId: target.id || "ground", targetType: target.type,
          units: attackersCount, unitIds: attackerIds
        }, actionIndex);
        return true;
      }

      // BUILD
      if (action === "build_warehouse") return this.tryBuildSpecific("warehouse", WAREHOUSE_COST, action, actionIndex, state);
      if (action === "build_repair") return this.tryBuildSpecific("repairWorkshop", REPAIR_WORKSHOP_COST, action, actionIndex, state);
      if (action === "build_barracks") return this.tryBuildSpecific("barracks", BARRACKS_COST, action, actionIndex, state);
      if (action === "build_beacon") return this.tryBuildSpecific("beacon", BEACON_COST, action, actionIndex, state);
      if (action === "build_turret1") return this.tryBuildSpecific("turret", TURRET_COST, action, actionIndex, state);
      if (action === "build_base2") return this.tryBuildSpecific("base2", BASE2_COST, action, actionIndex, state);
      if (action === "build_barracks2") return this.tryBuildSpecific("barracks2", BARRACKS2_COST, action, actionIndex, state);
      if (action === "build_turret2") return this.tryBuildSpecific("turret2", TURRET2_COST, action, actionIndex, state);
      if (action === "build_base3") return this.tryBuildSpecific("base3", BASE3_COST, action, actionIndex, state);
      if (action === "build_barracks3") return this.tryBuildSpecific("barracks3", BARRACKS3_COST, action, actionIndex, state);
      if (action === "build_turret3") return this.tryBuildSpecific("turret3", TURRET3_COST, action, actionIndex, state);

      // HIRE WORKER
      if (action === "hireWorker") {
        const w = gameState.buildings.find(b => b.owner === "ai" && b.type === "warehouse" && b.active && (b.workers || 0) < (b.maxDeliveryWorkers || 5));
        if (!w) return false;
        const res = gameState.aiResources;
        const cost = WORKER_COST;
        const canAfford = (res.gold || 0) >= (cost.gold || 0) && (res.silicon || 0) >= (cost.silicon || 0) && (res.plasma || 0) >= (cost.plasma || 0);
        if (!canAfford) return false;
        if (typeof aiHireWorker === "function") aiHireWorker(w);
        else {
          w.workers = (w.workers || 0) + 1;
          res.gold = Math.round((res.gold || 0) - (cost.gold || 0));
          res.silicon = Math.round((res.silicon || 0) - (cost.silicon || 0));
          res.plasma = Math.round((res.plasma || 0) - (cost.plasma || 0));
          if (typeof getUnitFromPool === "function" && typeof addUnit === "function") {
            const worker = getUnitFromPool("worker", "ai", w.x, w.y);
            worker.homeWarehouse = w;
            addUnit(worker);
          }
          if (typeof updateResourceUI === "function") updateResourceUI();
        }
        this.registerAction(action, state, { type: "hire", unitType: "worker" }, actionIndex);
        return true;
      }

      // HIRE REPAIRMAN
      if (action === "hireRepairman") {
        const r = gameState.buildings.find(b => b.owner === "ai" && b.type === "repairWorkshop" && b.active && (b.repairman || 0) < (b.capacity || 3));
        if (!r) return false;
        const res = gameState.aiResources;
        const cost = REPAIRMAN_COST;
        const canAfford = (res.gold || 0) >= (cost.gold || 0) && (res.silicon || 0) >= (cost.silicon || 0) && (res.plasma || 0) >= (cost.plasma || 0);
        if (!canAfford) return false;
        if (typeof aiHireRepairMan === "function") aiHireRepairMan(r);
        else {
          r.repairman = (r.repairman || 0) + 1;
          res.gold = Math.round((res.gold || 0) - (cost.gold || 0));
          res.silicon = Math.round((res.silicon || 0) - (cost.silicon || 0));
          res.plasma = Math.round((res.plasma || 0) - (cost.plasma || 0));
          if (typeof getUnitFromPool === "function" && typeof addUnit === "function") {
            const repairman = getUnitFromPool("repairman", "ai", r.x, r.y);
            repairman.homeWorkshop = r;
            addUnit(repairman);
          }
          if (typeof updateResourceUI === "function") updateResourceUI();
        }
        this.registerAction(action, state, { type: "hire", unitType: "repairman" }, actionIndex);
        return true;
      }

      // HIRE FIGHTER/ASSAULT/ELITE
      if (action === "hireFighter" || action === "hireAssault" || action === "hireElite") {
        const bType = action === "hireFighter" ? "barracks" : (action === "hireAssault" ? "barracks2" : "barracks3");
        const uType = action === "hireFighter" ? "fighter" : (action === "hireAssault" ? "assault" : "elite");
        const cost = action === "hireFighter" ? FIGHTER_COST : (action === "hireAssault" ? ASSAULT_COST : ELITE_COST);
        const hasRequiredBuilding = gameState.buildings.some(b => b.owner === "ai" && b.type === bType && b.health > 0 && b.active);
        if (hasRequiredBuilding && this.enqueueUnit(uType, bType, cost)) {
          this.registerAction(action, state, { type: "hire", unitType: uType }, actionIndex);
          return true;
        }
        this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -2.0 });
        return false;
      }

      // IDLE
      if (action === "idle") {
        this.registerAction(action, state, { type: "idle" }, actionIndex);
        return true;
      }

      // STRIKE_WEAK
      if (action === "strike_weak") {
        const targets = state.nodes.filter(n => n.valid && n.owner === "player" && ["warehouse","barracks","beacon","base","base2","base3"].includes(n.type) && n.hp > 0);
        targets.forEach(target => {
          const nearbyEnemies = state.nodes.filter(n => n.valid && n.owner === "player" && Math.hypot(n.x - target.x, n.y - target.y) < 200 && n !== target).length;
          target.isolationScore = nearbyEnemies;
          
          // АНАЛИЗ ОПЕРАЦИИ: Сколько наших юнитов уже идет на эту цель?
          const ourUnitsAlreadyAssigned = gameState.units.filter(u => 
            u.owner === "ai" && u.health > 0 && u.commandQueue && u.commandQueue.length > 0 &&
            u.commandQueue.some(cmd => cmd.type === "attack" && cmd.target && (cmd.target.id === target.obj?.id || Math.hypot(cmd.target.x - target.x, cmd.target.y - target.y) < 50))
          ).length;
          target.overkillPenalty = ourUnitsAlreadyAssigned * 10; // Штраф за скопление
        });
        
        targets.sort((a, b) => {
          const aPrio = {base: 10, base2: 10, base3: 10, warehouse: 8, barracks: 7, beacon: 6}[a.type] || 5;
          const bPrio = {base: 10, base2: 10, base3: 10, warehouse: 8, barracks: 7, beacon: 6}[b.type] || 5;
          // Сортируем по приоритету, минус изоляция, минус оверкилл
          return (bPrio - b.isolationScore * 2 - b.overkillPenalty) - (aPrio - a.isolationScore * 2 - a.overkillPenalty);
        });
        
        const target = targets[0];
        if (!target || target.hp <= 0) return false;
        
        const freeUnits = gameState.units.filter(u => u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0 && isUnitAvailable(u));
        if (freeUnits.length === 0) return false;
        
        // Ограничиваем количество атакующих, чтобы не слать всю армию на один склад
        const maxAttackers = Math.min(freeUnits.length, target.type === "warehouse" ? 4 : 8);
        const attackers = freeUnits.slice(0, maxAttackers);
        
        const threatZones = state.nodes.filter(n => n.valid && n.isVirtual && n.virtualType === "threat");
        const directPathBlocked = threatZones.some(zone => Math.hypot(zone.x - target.x, zone.y - target.y) < zone.threatRadius + 100);
        
        const waypoints = directPathBlocked
          ? (() => {
              const flankNodes = state.nodes.filter(n => n.valid && n.isVirtual && n.virtualType === "flank");
              const nearestFlank = flankNodes.reduce((best, n) => {
                const distToTarget = Math.hypot(n.x - target.x, n.y - target.y);
                const bestDist = best ? Math.hypot(best.x - target.x, best.y - target.y) : Infinity;
                return distToTarget < bestDist ? n : best;
              }, null);
              return nearestFlank ? [{type: "move", x: nearestFlank.x, y: nearestFlank.y}, {type: "move", x: target.x, y: target.y}] : [{type: "move", x: target.x + (target.y > aiBase.y ? -200 : 200), y: target.y}];
            })()
          : [{type: "move", x: target.x, y: target.y}];
          
        attackers.forEach(u => {
          const physicalTarget = (target.obj && target.obj.units) ? target.obj.units[0] : target.obj;
          u.commandQueue = [...waypoints, {type: "attack", target: physicalTarget}];
        });
        
        this.registerAction(action, state, {type: "attack", targetId: target.obj ? target.obj.id : "unknown", tactic: "strike_weak", targetIsolation: target.isolationScore, pathBlocked: directPathBlocked}, actionIndex);
        return true;
      }

      // FOCUS_FIRE
      if (action === "focus_fire") {
        const enemyTargets = state.nodes.filter(n => n.valid && n.owner === "player" && n.hp > 0);
        if (enemyTargets.length === 0) return false;
        
        enemyTargets.sort((a, b) => {
          const aIsBuilding = ["base","warehouse","barracks","turret"].includes(a.type) ? 0 : 1;
          const bIsBuilding = ["base","warehouse","barracks","turret"].includes(b.type) ? 0 : 1;
          if (aIsBuilding !== bIsBuilding) return aIsBuilding - bIsBuilding;
          // Приоритет: цель с наименьшим HP, но высоким приоритетом (добивание)
          if (a.targetPriority === b.targetPriority) return a.hp - b.hp; 
          return b.targetPriority - a.targetPriority;
        });
        
        let target = enemyTargets[0];
        // АНАЛИЗ: Если цель уже почти мертва (hp < 0.1), возможно, фокусить её уже не нужно, берем следующую
        if (target.hp < 0.1 && enemyTargets.length > 1) {
          target = enemyTargets[1];
        }
        
        const freeUnits = gameState.units.filter(u => u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0 && isUnitAvailable(u));
        if (freeUnits.length === 0) return false;
        
        freeUnits.forEach(u => {
          const physicalTarget = (target.obj && target.obj.units) ? target.obj.units[0] : target.obj;
          // Добавляем команду "преследовать" или просто атаковать
          u.commandQueue = [{
            type: "attack",
            target: physicalTarget || {x: target.x, y: target.y, type: target.type, owner: "player", health: target.hp * 100}
          }];
        });
        
        this.registerAction(action, state, {type: "attack", targetId: target.obj?.id || "unknown", tactic: "focus_fire"}, actionIndex);
        return true;
      }

      // RETREAT_REGROUP
      if (action === "retreat_regroup") {
        const wounded = gameState.units.filter(u =>
          u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) &&
          u.health > 0 && u.health < u.maxHealth * 0.5
        );
        const aiCombat = gameState.units.filter(u => u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0);
        const rallyPoint = aiCombat.length >= 3
          ? { x: aiCombat.reduce((s, u) => s + u.x, 0) / aiCombat.length, y: aiCombat.reduce((s, u) => s + u.y, 0) / aiCombat.length }
          : aiBase;
        wounded.forEach(u => {
          u.commandQueue = [{type: "move", x: rallyPoint.x + (Math.random() - 0.5) * 100, y: rallyPoint.y + (Math.random() - 0.5) * 100}];
        });
        this.registerAction(action, state, {type: "retreat", anchor: rallyPoint}, actionIndex);
        return true;
      }

      // FLANK_ATTACK
      if (action === "flank_attack") {
        const flankNodes = state.nodes.filter(n => n.valid && n.isVirtual && n.virtualType === "flank");
        const freeUnits = gameState.units.filter(u => u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0 && isUnitAvailable(u));
        
        if (freeUnits.length < 2) return false;
        
        const groups = this.splitArmyIntoGroups(freeUnits, 2);
        const targetNode = state.nodes.find(n =>
          n.valid && n.owner === "player" &&
          (n.type.includes("base") || ["fighter","assault","elite","warehouse","barracks"].includes(n.type)) && n.hp > 0
        );
        
        // Если главная цель пропала, ищем любую другую вражескую единицу
        const fallbackTarget = targetNode ? targetNode.obj : gameState.units.find(u => u.owner === "player" && u.health > 0) || gameState.buildings.find(b => b.owner === "player" && b.health > 0);
        if (!fallbackTarget) return false;

        groups.forEach((group, idx) => {
          const flankPoint = flankNodes.length > idx ? flankNodes[idx] : { x: fallbackTarget.x + (idx === 0 ? -200 : 200), y: fallbackTarget.y };
          group.forEach(u => {
            const physicalTarget = (targetNode && targetNode.obj && targetNode.obj.units)
              ? targetNode.obj.units[0]
              : fallbackTarget;
            
            // АНАЛИЗ: Даем команду двигаться к точке фланга, но как только враг в радиусе атаки, движок игры сам должен переключить на атаку.
            // Мы добавляем "умный" вейпоинт: если цель близко, идем прямо на неё.
            const distToTarget = Math.hypot(u.x - fallbackTarget.x, u.y - fallbackTarget.y);
            if (distToTarget < 300) {
              u.commandQueue = [{type: "attack", target: physicalTarget}];
            } else {
              u.commandQueue = [
                {type: "move", x: flankPoint.x, y: flankPoint.y},
                {type: "attack", target: physicalTarget}
              ];
            }
          });
        });
        
        this.registerAction(action, state, {
          type: "attack", tactic: "flank",
          group1Size: groups[0].length, group2Size: groups[1].length
        }, actionIndex);
        return true;
      }

      // HARASS_ECONOMY
      if (action === "harass_economy") {
        const ecoTargets = state.nodes.filter(n =>
          n.valid && n.owner === "player" &&
          ["warehouse","repairWorkshop","worker"].includes(n.type) && n.hp > 0
        );
        if (ecoTargets.length === 0) return false;
        
        ecoTargets.sort((a, b) => {
          const distA = Math.hypot(a.x - aiBase.x, a.y - aiBase.y);
          const distB = Math.hypot(b.x - aiBase.x, b.y - aiBase.y);
          return distA - distB; // Ближайшая цель
        });
        
        const target = ecoTargets[0];
        const fighters = gameState.units.filter(u =>
          u.owner === "ai" && u.type === "fighter" && u.health > 0 && isUnitAvailable(u)
        );
        if (fighters.length === 0) return false;
        
        fighters.forEach(u => {
          const physicalTarget = (target.obj && target.obj.units) ? target.obj.units[0] : target.obj;
          
          // АНАЛИЗ ОПЕРАЦИИ: Если юнит уже ранен (>30% потерь), заставляем его отступать вместо атаки
          if (u.health < u.maxHealth * 0.7) {
            u.commandQueue = [{type: "move", x: aiBase.x + (Math.random()-0.5)*100, y: aiBase.y + (Math.random()-0.5)*100}];
          } else {
            u.commandQueue = [{
              type: "attack",
              target: physicalTarget || {x: target.x, y: target.y, type: target.type, owner: "player", health: target.hp * 100}
            }];
          }
        });
        
        this.registerAction(action, state, {
          type: "attack", tactic: "harass_economy",
          targetId: target.obj ? (target.obj.id || (target.obj.units ? target.obj.units[0].id : "unknown")) : "unknown"
        }, actionIndex);
        return true;
      }
    } catch (e) {
      console.warn("[GnnAI execute error]", action, e);
    }
    return false;
  },

  // === Постройка конкретного здания ===
  tryBuildSpecific: function(buildingType, cost, action, actionIndex, state) {
    const res = gameState.aiResources;
    const canAfford = (res.gold || 0) >= (cost.gold || 0) &&
                      (res.silicon || 0) >= (cost.silicon || 0) &&
                      (res.plasma || 0) >= (cost.plasma || 0);
    if (!canAfford) {
      this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -0.3 });
      return false;
    }
    const prereq = this.PREREQUISITES[buildingType];
    if (prereq && !gameState.buildings.some(b => b.owner === "ai" && b.type === prereq && b.health > 0)) {
      this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -5.0 });
      console.warn(`[GnnAI] ⛔ Хак заблокирован: ${buildingType} без ${prereq}`);
      return false;
    }
    let anchor = aiBase;
    if (buildingType === "beacon") {
      let far = aiBase, maxD = 0;
      gameState.buildings.forEach(b => {
        if (b.owner === "ai" && b.active && b.health > 0) {
          const d = Math.hypot(b.x - aiBase.x, b.y - aiBase.y);
          if (d > maxD) { maxD = d; far = b; }
        }
      });
      anchor = far;
      const cluster = this.findBestResourceCluster();
      if (cluster) {
        const ang = Math.atan2(cluster.y - far.y, cluster.x - far.x);
        const r = 200;
        const tx = far.x + Math.cos(ang) * r;
        const ty = far.y + Math.sin(ang) * r;
        const pos = this.findBuildPos({x: tx, y: ty}, "beacon", 0, 120);
        if (pos) {
          const scheduled = scheduleAIBuilding("beacon", pos.x, pos.y, 0);
          if (scheduled) {
            this.registerAction(action, state, { type: "build", buildingType: "beacon" }, actionIndex);
            return true;
          }
        }
      }
    } else if (["warehouse","repairWorkshop","turret","turret2","turret3"].includes(buildingType)) {
      const outpost = this.findExpansionAnchor();
      if (outpost) {
        const pos = this.findBuildPos(outpost, buildingType, 60, 150);
        if (!pos) {
          this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -0.3 });
          return false;
        }
        const scheduled = scheduleAIBuilding(buildingType, pos.x, pos.y, 0);
        if (scheduled) {
          this.registerAction(action, state, { type: "build", buildingType: buildingType }, actionIndex);
          return true;
        }
        return false;
      }
      const wh = gameState.buildings.find(b => b.owner === "ai" && b.type === "warehouse" && b.health > 0);
      if (wh) anchor = wh;
    } else if (["barracks","barracks2","barracks3","base2","base3"].includes(buildingType)) {
      const outpost = this.findExpansionAnchor();
      if (outpost) anchor = outpost;
      else {
        const wh = gameState.buildings.find(b => b.owner === "ai" && b.type === "warehouse" && b.health > 0);
        if (wh) anchor = wh;
      }
    }
    const pos = this.findBuildPos(anchor, buildingType, 70, 240);
    if (!pos) {
      // ИСПРАВЛЕНО: Если места нет, не штрафуем слепо, а пробуем найти новый якорь экспансии
      if (["warehouse","barracks","barracks2","barracks3"].includes(buildingType)) {
        const newAnchor = this.findExpansionAnchor();
        if (newAnchor && newAnchor !== aiBase) {
          const newPos = this.findBuildPos(newAnchor, buildingType, 60, 150);
          if (newPos) {
            const scheduled = scheduleAIBuilding(buildingType, newPos.x, newPos.y, 0);
            if (scheduled) {
              this.registerAction(action, state, { type: "build", buildingType: buildingType, isExpansion: true }, actionIndex);
              return true;
            }
          }
        }
      }
      // Если все равно не вышло, тогда мягкий штраф, но не за саму идею постройки, а за нехватку места
      this.replay.push({ X: state.X, A_distance: state.A_distance, A_threat: state.A_threat, actionIndex: actionIndex, reward: -0.1 });
      return false;
    }
    const scheduled = scheduleAIBuilding(buildingType, pos.x, pos.y, 0);
    if (scheduled) {
      this.registerAction(action, state, { type: "build", buildingType: buildingType }, actionIndex);
      return true;
    }
    return false;
  },

  // === Постановка юнита в очередь ===
  enqueueUnit: function (type, buildingType, cost) {
    const b = gameState.buildings.find(x => x.owner === "ai" && x.type === buildingType && x.active && (!x.productionQueue || x.productionQueue.length < (x.productionLimit || 3)));
    if (!b || !canSpendResources(cost, "ai") || typeof aiEnqueueMilitaryUnit !== "function") return false;
    if (!aiEnqueueMilitaryUnit(type, b)) return false;
    gameState.aiResources.gold = Math.round((gameState.aiResources.gold || 0) - (cost.gold || 0));
    gameState.aiResources.silicon = Math.round((gameState.aiResources.silicon || 0) - (cost.silicon || 0));
    gameState.aiResources.plasma = Math.round((gameState.aiResources.plasma || 0) - (cost.plasma || 0));
    if (typeof updateResourceUI === "function") updateResourceUI();
    return true;
  },

  // === Авто-экономика (отключена в GNN) ===
  autoEconomy: function () {
    if (gameMode === "gnn") return;
    if (window.fullRLMode) return;
    if (typeof aiHireWorker !== "function") return;
    for (const b of gameState.buildings) {
      if (b.owner !== "ai" || !b.active) continue;
      if (b.type === "warehouse") {
        const maxWorkers = b.maxDeliveryWorkers || 5;
        const currentWorkers = b.workers || 0;
        if (currentWorkers < Math.ceil(maxWorkers / 2)) {
          let guard = 0;
          while (currentWorkers + guard < maxWorkers && guard < 1 && canSpendResources(WORKER_COST, "ai")) {
            aiHireWorker(b);
            guard++;
          }
        }
      }
      if (b.type === "repairWorkshop" && typeof aiHireRepairMan === "function") {
        const woundedUnits = gameState.units.filter(u => u.owner === "ai" && u.health > 0 && u.health < u.maxHealth).length;
        const maxRepairmen = b.capacity || 3;
        const currentRepairmen = b.repairman || 0;
        if (woundedUnits > 0 && currentRepairmen < maxRepairmen) {
          let guard = 0;
          while (currentRepairmen + guard < maxRepairmen && guard < 1 && canSpendResources(REPAIRMAN_COST, "ai")) {
            aiHireRepairMan(b);
            guard++;
          }
        }
      }
    }
  },

  // === Якорь угрозы ===
  threatAnchor: function () {
    const anchors = gameState.buildings.filter(b => b.owner === "ai" && ["base","base2","base3","beacon","warehouse","repairWorkshop","barracks","barracks2","barracks3"].includes(b.type) && b.health > 0);
    if (!anchors.length) return aiBase;
    const enemies = [...gameState.units.filter(u => u.owner === "player" && u.health > 0), ...gameState.buildings.filter(b => b.owner === "player" && b.health > 0)];
    let best = aiBase, bestScore = -Infinity;
    for (const a of anchors) {
      let score = (1 - a.health / a.maxHealth) * 150 + (a.type.startsWith("base") ? 100 : 50);
      for (const e of enemies) {
        const d = Math.hypot(a.x - e.x, a.y - e.y);
        if (d < CFG.BASE_THREAT_RADIUS) score += ((CFG.BASE_THREAT_RADIUS - d) / CFG.BASE_THREAT_RADIUS) * 200;
      }
      const existingDefenders = gameState.units.filter(u => u.owner === "ai" && u.defending && Math.hypot(u.x - a.x, u.y - a.y) < 200).length;
      score -= existingDefenders * 30;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  },

  // === Якорь экспансии (ИСПРАВЛЕНО: учет ресурсов) ===
  findExpansionAnchor: function () {
    const beacons = gameState.buildings.filter(b =>
      b.owner === "ai" && b.type === "beacon" && b.active && b.health > 0
    );
    if (beacons.length === 0) return aiBase;
    
    // Находим все ценные ресурсы
    const valuableResources = gameState.resources.filter(r => r.amount > 30);
    
    const scored = beacons.map(bc => {
      const nearbyUseful = gameState.buildings.filter(b =>
        b.owner === "ai" && b !== bc &&
        ["warehouse","repairWorkshop","barracks","barracks2","barracks3","turret","turret2","turret3"].includes(b.type) &&
        Math.hypot(b.x - bc.x, b.y - bc.y) < 220
      ).length;
      
      // ОЦЕНКА ЛОГИСТИКИ: насколько близко этот маяк к свободным ресурсам
      let resourceScore = 0;
      let minResourceDist = 9999;
      valuableResources.forEach(r => {
        const dist = Math.hypot(r.x - bc.x, r.y - bc.y);
        if (dist < 400) {
          // Проверяем, не покрыт ли ресурс другим складом
          const isCovered = gameState.buildings.some(w => 
            w.owner === "ai" && w.type === "warehouse" && Math.hypot(w.x - r.x, w.y - r.y) < 320
          );
          if (!isCovered) {
            resourceScore += (400 - dist) * (r.amount / 100); // Чем ближе и богаче, тем лучше
            if (dist < minResourceDist) minResourceDist = dist;
          }
        }
      });

      return { 
        beacon: bc, 
        useful: nearbyUseful, 
        resourceScore: resourceScore,
        minResourceDist: minResourceDist,
        distToBase: Math.hypot(bc.x - aiBase.x, bc.y - aiBase.y) 
      };
    });
    
    // Сортировка: сначала те, где есть ресурсы, потом те, где меньше всего построек (чтобы развивать слабые), потом дальние
    scored.sort((a, b) => {
      if (a.resourceScore !== b.resourceScore) return b.resourceScore - a.resourceScore; // Максимум ресурсов
      if (a.useful !== b.useful) return a.useful - b.useful; // Минимум построек (нуждается в развитии)
      return b.distToBase - a.distToBase; // Дальние приоритетнее для экспансии
    });
    
    const target = scored[0];
    // Если у лучшего маяка уже 3+ полезных здания, считаем его развитым, возвращаем null (или ищем следующий)
    if (target.useful >= 3 && target.resourceScore < 50) return null;
    return target.beacon;
  },

  // === Поиск позиции для постройки ===
  findBuildPos: function (anchor, type, minR = 80, maxR = 310) {
    if (!anchor) anchor = aiBase;
    const wW = typeof worldWidth !== 'undefined' ? worldWidth : 2000;
    const wH = typeof worldHeight !== 'undefined' ? worldHeight : 2000;
    const safeMargin = 60;
    for (let i = 0; i < 200; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = minR + Math.random() * (maxR - minR);
      const x = anchor.x + Math.cos(a) * r;
      const y = anchor.y + Math.sin(a) * r;
      if (x < safeMargin || y < safeMargin || x > wW - safeMargin || y > wH - safeMargin) continue;
      if (typeof isValidAiBuildLocation === "function" && !isValidAiBuildLocation(x, y)) continue;
      const dims = {
        warehouse: [10, 10], repairWorkshop: [10, 10],
        barracks: [15, 15], barracks2: [15, 15], barracks3: [15, 15],
        turret: [12, 12], turret2: [15, 17], turret3: [14, 15],
        beacon: [7, 20], base2: [25, 30], base3: [30, 30]
      }[type] || [20, 20];
      const rect = { left: x - dims[0] / 2, top: y - dims[1] / 2, right: x + dims[0] / 2, bottom: y + dims[1] / 2 };
      let bad = false;
      for (const b of gameState.buildings) {
        const br = { left: b.x - b.width / 2 - 5, top: b.y - b.height / 2 - 5, right: b.x + b.width / 2 + 5, bottom: b.y + b.height / 2 + 5 };
        if (typeof rectsOverlap === "function" && rectsOverlap(rect, br)) { bad = true; break; }
      }
      if (!bad) {
        //console.log(`[GnnAI] ✅ Найдено место: ${type} на (${x.toFixed(0)}, ${y.toFixed(0)})`);
        return { x, y };
      }
    }
    const offsets = [
      { x: anchor.x + 200, y: anchor.y }, { x: anchor.x - 200, y: anchor.y },
      { x: anchor.x, y: anchor.y + 200 }, { x: anchor.x, y: anchor.y - 200 }
    ];
    for (const pos of offsets) {
      if (pos.x < safeMargin || pos.y < safeMargin || pos.x > wW - safeMargin || pos.y > wH - safeMargin) continue;
      if (typeof isValidAiBuildLocation === "function" && !isValidAiBuildLocation(pos.x, pos.y)) continue;
      const dims = { warehouse: [10, 10], repairWorkshop: [10, 10], barracks: [15, 15], turret: [12, 12], beacon: [7, 20] }[type] || [20, 20];
      const rect = { left: pos.x - dims[0] / 2, top: pos.y - dims[1] / 2, right: pos.x + dims[0] / 2, bottom: pos.y + dims[1] / 2 };
      let bad = false;
      for (const b of gameState.buildings) {
        const br = { left: b.x - b.width / 2 - 5, top: b.y - b.height / 2 - 5, right: b.x + b.width / 2 + 5, bottom: b.y + b.height / 2 + 5 };
        if (typeof rectsOverlap === "function" && rectsOverlap(rect, br)) { bad = true; break; }
      }
      if (!bad) return pos;
    }
    return null;
  }

});