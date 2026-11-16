// ============================================================
// 08-helpers.js — metrics, registerAction, shaped rewards, wrappers
// ============================================================
"use strict";

Object.assign(window.GnnAI, {

  // === Метрики состояния (с кэшированием) ===
  metrics: function () {
    if (this._metricsCache && performance.now() - this._metricsCacheTime < 100) {
      return this._metricsCache;
    }
    const baseHp = aiBase && aiBase.maxHealth ? Math.max(0, aiBase.health / aiBase.maxHealth) : 0;
    const enemyNear = gameState.units.filter(u => u.owner === "player" && u.health > 0 && aiBase && Math.hypot(u.x - aiBase.x, u.y - aiBase.y) < CFG.BASE_THREAT_RADIUS).length;
    const aiArmy = gameState.units.filter(u => u.owner === "ai" && ["fighter","assault","elite"].includes(u.type) && u.health > 0).length;
    const enemyArmy = gameState.units.filter(u => u.owner === "player" && ["fighter","assault","elite"].includes(u.type) && u.health > 0).length;
    let techLevel = 1;
    if (gameState.buildings.some(b => b.owner === "ai" && ["base2","barracks2","turret2"].includes(b.type))) techLevel = 2;
    if (gameState.buildings.some(b => b.owner === "ai" && ["base3","barracks3","turret3"].includes(b.type))) techLevel = 3;
    const aiBuildings = gameState.buildings.filter(b => b.owner === "ai" && b.health > 0).length;
    const aiTurrets = gameState.buildings.filter(b => b.owner === "ai" && b.type?.startsWith("turret") && b.health > 0).length;
    const aiWarehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.health > 0).length;
    const playerAlive = gameState.buildings.some(b => b.owner === "player" && b.health > 0);
    const ar = gameState.aiResources || {};
    const resTotalRaw = (ar.gold || 0) + (ar.silicon || 0) + (ar.plasma || 0);
    const resTotal = Math.min(1, resTotalRaw / 2000);
    const ecoEfficiency = resTotal > 0.001 ? (aiArmy / (resTotal / 100)) : 0;
    const result = {
      baseHp, enemyNear, aiArmy, enemyArmy, techLevel, aiBuildings, aiTurrets, aiWarehouses, playerAlive,
      resTotal, ecoEfficiency,
      res: { gold: Math.round(ar.gold || 0), silicon: Math.round(ar.silicon || 0), plasma: Math.round(ar.plasma || 0) }
    };
    this._metricsCache = result;
    this._metricsCacheTime = performance.now();
    return result;
  },

  // === Маршрутизация shaping-наград на реальное действие ===
  addShapedReward: function (reward, tag) {
    if (!isFinite(reward) || reward === 0) return;
    if (this.lastReplayEntry) {
      this.lastReplayEntry.reward += reward;
      this.lastReplayEntry.shapedTags = this.lastReplayEntry.shapedTags || [];
      if (tag) this.lastReplayEntry.shapedTags.push(tag);
    } else {
      this._pendingShaped += reward;
    }
  },

  // === Перехват фиктивных записей с actionIndex = idle ===
  _wrapReplayPush: function () {
    const rb = this.replay;
    if (!rb || rb.__shapedPatched) return;
    const origPush = rb.push.bind(rb);
    const self = this;
    rb.push = function (item) {
      if (item && item.actionIndex === self._AIDX.idle && !item.actionMask) {
        self.addShapedReward(item.reward, item.tag || "eval");
        return;
      }
      origPush(item);
    };
    rb.__shapedPatched = true;
  },

  // === Регистрация действия (снимок + missionLog) ===
  registerAction: function (action, graphState, intent, actionIndex, isExpert = false) {
    if (!graphState || !graphState.X || !graphState.A_distance) return;
    let currentValue = 0;
    let currentLogProb = 0;
    const actionMask = this.validActionMask();
    if (this.model) {
      const pred = this.predictData(graphState);
      if (pred) {
        currentValue = pred.value[0];
        const logits = pred.logits;
        const maskedLogits = logits.map((v, i) => actionMask[i] === 1 ? v : -1e9);
        const maxLogit = Math.max(...maskedLogits);
        const expLogits = maskedLogits.map(v => Math.exp(v - maxLogit));
        const sumExp = expLogits.reduce((a, b) => a + b, 0) || 1;
        const probs = expLogits.map(v => v / sumExp);
        currentLogProb = Math.log(probs[actionIndex] || 1e-10);
      }
    }
    const replayEntry = {
      X: graphState.X,
      A_distance: graphState.A_distance,
      A_threat: graphState.A_threat,
      actionIndex: actionIndex !== undefined ? actionIndex : -1,
      actionMask: actionMask,
      oldLogProb: currentLogProb,
      value: currentValue,
      reward: 0,
      isExpert: isExpert
    };
    if (this._pendingShaped) {
      replayEntry.reward += this._pendingShaped;
      this._pendingShaped = 0;
    }
    this.replay.push(replayEntry);
    this.lastReplayEntry = replayEntry;

    const m = this.metrics();
    const snapshot = {
      threatLevel: this.strategicMemory.threatLevel,
      aiArmy: m.aiArmy,
      resTotal: m.resTotal,
      ecoEfficiency: m.ecoEfficiency,
      techLevel: m.techLevel,
      aiBuildings: m.aiBuildings,
      aiWarehouses: m.aiWarehouses,
      aiTurrets: m.aiTurrets,
      time: performance.now(),
      baseHp: m.baseHp
    };
    if (this.episodeReport) {
      this.episodeReport.actions[action] = (this.episodeReport.actions[action] || 0) + 1;
      this.episodeReport.timeline.push({
        time: (performance.now() / 1000).toFixed(1) + ' сек',
        action: action,
        detail: intent && intent.type === "build" ? intent.buildingType : (intent && intent.type === "hire" ? intent.unitType : intent.type),
        resources: m.resTotal,
        army: m.aiArmy,
        tech: m.techLevel
      });
    }
    if (intent && intent.unitIds && intent.unitIds.length > 0) {
      snapshot.unitStartHP = intent.unitIds.reduce((sum, id) => {
        const u = gameState.units.find(x => x.id === id);
        return sum + (u ? u.health : 0);
      }, 0);
      if (intent.targetId) {
        const target = gameState.units.find(u => u.id === intent.targetId) || gameState.buildings.find(b => b.id === intent.targetId);
        snapshot.targetStartHP = target ? target.health : 0;
        snapshot.targetId = intent.targetId;
      }
      if (intent.anchor) snapshot.anchorId = intent.anchor;
    }
    if (intent && intent.type === "defend") {
      let anchor = null;
      if (intent.anchor === "aiBase") anchor = window.aiBase;
      else anchor = gameState.buildings.find(b => b.id === intent.anchor);
      if (anchor) {
        snapshot.enemiesNearAnchorAtStart = gameState.units.filter(u =>
          u.owner === "player" && u.health > 0 && Math.hypot(u.x - anchor.x, u.y - anchor.y) < 300
        ).length;
      } else snapshot.enemiesNearAnchorAtStart = 0;
    }
    this.missionCache.push({
      action: action,
      intent: intent,
      snapshot: snapshot,
      resolved: false,
      replayEntry: replayEntry
    });

    // Событийное логирование на каждый юнит миссии
    if (intent && intent.unitIds && intent.unitIds.length > 0) {
      for (const uid of intent.unitIds) {
        const u = gameState.units.find(x => x.id === uid);
        if (!u) continue;
        u.missionLog = {
          missionId: this.missionCache.length - 1,
          action: action,
          tactic: intent.tactic || null,
          intentType: intent.type,
          targetId: intent.targetId || null,
          targetStartHP: intent.targetId ? (gameState.units.find(x=>x.id===intent.targetId)?.health || gameState.buildings.find(b=>b.id===intent.targetId)?.health || 0) : 0,
          waypoints: intent.waypoints || [],
          startTime: performance.now(),
          events: [],
          damageDealt: 0,
          damageTaken: 0,
          killedBy: null,
          deathPos: null,
          reachedTarget: false,
          completedMission: false,
          alive: true
        };
      }
    }

    // Achievements & Immediate Rewards
    if (this.episodeAchievements && intent) {
      let achievementBonus = 0;
      if (intent.type === "build") {
        if (intent.buildingType === "beacon" && !this.episodeAchievements.firstBeacon) {
          this.episodeAchievements.firstBeacon = true;
          achievementBonus = 40.0;
        }
        if (intent.buildingType === "barracks" && !this.episodeAchievements.firstBarracks) {
          this.episodeAchievements.firstBarracks = true; achievementBonus = 50.0;
        } else if (intent.buildingType === "base2" && !this.episodeAchievements.firstBase2) {
          this.episodeAchievements.firstBase2 = true; achievementBonus = 150.0;
        } else if (intent.buildingType === "barracks2" && !this.episodeAchievements.firstBarracks2) {
          this.episodeAchievements.firstBarracks2 = true; achievementBonus = 110.0;
        } else if (intent.buildingType === "base3" && !this.episodeAchievements.firstBase3) {
          this.episodeAchievements.firstBase3 = true; achievementBonus = 200.0;
        } else if (intent.buildingType === "barracks3" && !this.episodeAchievements.firstBarracks3) {
          this.episodeAchievements.firstBarracks3 = true; achievementBonus = 150.0;
        }
      } else if (intent.type === "hire") {
        if (intent.unitType === "worker") {
          const currentWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
          if (currentWorkers === 0) replayEntry.reward += 10.0;
        }
        if (intent.unitType === "assault" && !this.episodeAchievements.firstAssault) {
          this.episodeAchievements.firstAssault = true; achievementBonus = 20.0;
        } else if (intent.unitType === "elite" && !this.episodeAchievements.firstElite) {
          this.episodeAchievements.firstElite = true; achievementBonus = 30.0;
        }
      }
      if (achievementBonus > 0) replayEntry.reward += achievementBonus;
    }
    if (intent && intent.type === "hire" && ["fighter","assault","elite"].includes(intent.unitType)) {
      const workers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
      const warehouses = gameState.buildings.filter(b => b.owner === "ai" && b.type === "warehouse" && b.active).length;
      const gameTimeMin = performance.now() / 60000;
      if (gameTimeMin > 0.5 && (workers < 2 || warehouses === 0)) {
        replayEntry.reward += -5.0;
      }
    }
  },

  // === Умный поиск слабых мест на основе графа ===
  findBestTacticalTarget: function(state, tacticType) {
    if (!state || !state.nodes) return null;
    const enemyNodes = state.nodes.filter(n =>
      n.valid && n.owner === "player" && n.type !== "gold" && n.type !== "silicon" && n.type !== "plasma"
    );
    if (enemyNodes.length === 0) return null;
    let bestTarget = null;
    let bestScore = -Infinity;
    for (const node of enemyNodes) {
      let score = 0;
      if (node.type === "base" || node.type === "base2" || node.type === "base3") score += 100;
      else if (node.type === "warehouse") score += 80;
      else if (node.type === "barracks" || node.type === "barracks2" || node.type === "barracks3") score += 70;
      else if (node.type === "repairWorkshop") score += 60;
      else if (node.type.startsWith("turret")) score += 40;
      else score += 20;

      const nearbyThreat = enemyNodes.filter(other => {
        if (other === node) return false;
        const dist = Math.hypot(node.x - other.x, node.y - other.y);
        return dist < 250;
      }).length;
      if (nearbyThreat >= 3) score -= 60;
      else if (nearbyThreat >= 2) score -= 30;
      else if (nearbyThreat === 0) score += 40;

      if (tacticType === "flank_attack" || tacticType === "strike_weak") {
        if (nearbyThreat === 0 && (node.type === "warehouse" || node.type === "barracks" || node.type.includes("base"))) {
          score += 100;
        }
      } else if (tacticType === "tactic_push" || tacticType === "tactic_all_in") {
        score += nearbyThreat * 5;
      }
      if (score > bestScore) {
        bestScore = score;
        bestTarget = node;
      }
    }
    return bestTarget;
  }

});