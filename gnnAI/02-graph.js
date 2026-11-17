// ============================================================
// 02-graph.js — Граф состояния: getGlobalFeatures, clusterUnits,
//               buildGraphState, nodeFeatures, generateVirtualNodes
// ============================================================
"use strict";

Object.assign(window.GnnAI, {

  // === Глобальные признаки (39 штук) ===
  getGlobalFeatures: function () {
    if (!window.gameState || !window.aiBase) return new Array(CFG.GLOBAL_FEATURES).fill(0);
    const m = this.metrics();
    const threat = Math.min(1, this.strategicMemory.threatLevel / 30);
    const baseHp = m.baseHp;
    const enemyNear = Math.min(1, m.enemyNear / 10);
    const myArmy = Math.min(1, m.aiArmy / 20);
    const enemyArmy = Math.min(1, m.enemyArmy / 20);
    const armyBalance = Math.min(1, m.aiArmy / (m.enemyArmy + 1));
    let tech = 1;
    if (gameState.buildings.some(b => b.owner === "ai" && ["base2","barracks2","turret2"].includes(b.type))) tech = 2;
    if (gameState.buildings.some(b => b.owner === "ai" && ["base3","barracks3","turret3"].includes(b.type))) tech = 3;
    const techLevel = tech / 3;
    const resTotal = Math.min(1, (m.res.gold + m.res.silicon + m.res.plasma) / 500);
    const warehouseCount = Math.min(1, m.aiWarehouses / 10);
    const turretCount = Math.min(1, m.aiTurrets / 10);
    const timeNorm = Math.min(1, performance.now() / 600000);
    const enemyTurrets = Math.min(1, gameState.buildings.filter(b => b.owner === "player" && b.type?.startsWith("turret")).length / 10);
    const enemyElites = Math.min(1, (this.strategicMemory.enemyComposition.elite || 0) / 5);
    const buildingDiversity = Math.min(1, m.aiBuildings / 15);
    const resourceEfficiency = m.resTotal > 0 ? Math.min(1, m.aiArmy / (m.resTotal / 100)) : 0;
    const expansionProgress = Math.min(1, m.aiWarehouses / 5);
    const defenseStrength = Math.min(1, m.aiTurrets / 5);
    const gameTimeMinutes = performance.now() / 60000;
    const techStagnationPenalty = gameTimeMinutes > 3 && tech < 2 ? 1 : 0;
    let totalEnemyDps = 0, totalMyDps = 0;
    gameState.units.forEach(u => {
      const dps = this.getUnitDps(u.type) || 0;
      if (u.owner === "player" && u.health > 0) totalEnemyDps += dps;
      if (u.owner === "ai" && u.health > 0) totalMyDps += dps;
    });
    const enemyWorkers = gameState.units.filter(u => u.owner === "player" && u.type === "worker" && u.health > 0).length;
    const myWorkers = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length;
    const economyGap = Math.max(-1, Math.min(1, (myWorkers - enemyWorkers) / 8));
    const enemyArmyValue = gameState.units.filter(u => u.owner === "player" && u.health > 0).reduce((s, u) => s + this.getUnitValue(u.type), 0);
    const myArmyValue = gameState.units.filter(u => u.owner === "ai" && u.health > 0).reduce((s, u) => s + this.getUnitValue(u.type), 0);
    const armyGap = Math.max(-1, Math.min(1, (myArmyValue - enemyArmyValue) / 600));
    let enemyTech = 1;
    if (gameState.buildings.some(b => b.owner === "player" && ["base2","barracks2","turret2"].includes(b.type))) enemyTech = 2;
    if (gameState.buildings.some(b => b.owner === "player" && ["base3","barracks3","turret3"].includes(b.type))) enemyTech = 3;
    const techGap = (tech - enemyTech) / 2;
    const myPowerScore = (tech * 10) + myArmyValue + (m.aiTurrets * 5);
    const enemyPowerScore = (enemyTech * 10) + enemyArmyValue + (enemyTurrets * 5);
    const momentum = Math.tanh((myPowerScore - enemyPowerScore) / 50);
    const progressToWin = Math.min(1, myPowerScore / 200);

    // Экономическая математика
    const totalResources = m.res.gold + m.res.silicon + m.res.plasma;
    const estimatedIncomePerSec = myWorkers * 0.5;
    const timeToAffordWarehouse = totalResources > 0 ? (12 + 5 + 3) / (estimatedIncomePerSec || 1) : 999;
    const expansionCost = (27 + 38 + 12) + (12 + 5 + 3);
    const isRichEnoughToExpand = totalResources >= expansionCost ? 1 : 0;
    const totalWarehouses = m.aiWarehouses;
    const workerDeficit = Math.max(0, (totalWarehouses * 3) - myWorkers);
    const isEconomyChoked = workerDeficit > 0 ? 1 : 0;

    const emptyWh = gameState.buildings.filter(b =>
      b.owner === "ai" && b.type === "warehouse" &&
      (b.active || (b.builtAt && !b.active)) &&
      (b.workers || 0) === 0
    ).length;
    const emptyRatio = m.aiWarehouses > 0 ? emptyWh / m.aiWarehouses : 0;
    const income = gameState.units.filter(u => u.owner === "ai" && u.type === "worker" && u.health > 0).length * 0.5;

    // Тактическая обстановка
    const enemyClusters = [], ourClusters = [];
    const enemyCombat = gameState.units.filter(u => u.owner === "player" && u.health > 0 && ["fighter","assault","elite"].includes(u.type));
    for (const e of enemyCombat) {
      const allies = enemyCombat.filter(o => o !== e && Math.hypot(o.x - e.x, o.y - e.y) < 200).length;
      if (allies >= 2) enemyClusters.push({x: e.x, y: e.y, size: allies + 1});
    }
    const aiCombat = gameState.units.filter(u => u.owner === "ai" && u.health > 0 && ["fighter","assault","elite"].includes(u.type));
    for (const a of aiCombat) {
      const allies = aiCombat.filter(o => o !== a && Math.hypot(o.x - a.x, o.y - a.y) < 200).length;
      if (allies >= 2) ourClusters.push({x: a.x, y: a.y, size: allies + 1});
    }
    const enemyClusterThreat = Math.min(1, enemyClusters.length / 3);
    const ourClusterStrength = Math.min(1, ourClusters.length / 2);
    let nearestEnemyClusterDist = 1.0;
    for (const c of enemyClusters) {
      const d = Math.hypot(c.x - aiBase.x, c.y - aiBase.y);
      nearestEnemyClusterDist = Math.min(nearestEnemyClusterDist, d / 800);
    }
    let flankOpportunity = 0;
    if (enemyClusters.length > 0 && ourClusters.length > 0) {
      const enemyCenterX = enemyClusters.reduce((s,c) => s+c.x, 0) / enemyClusters.length;
      const ourCenterX = ourClusters.reduce((s,c) => s+c.x, 0) / ourClusters.length;
      const baseX = aiBase.x;
      if ((enemyCenterX < baseX) !== (ourCenterX < baseX)) flankOpportunity = 1.0;
    }
    let localPowerBalance = 0;
    if (ourClusters.length > 0 && enemyClusters.length > 0) {
      const ourPower = ourClusters.reduce((s,c) => s + c.size * 30, 0);
      const enemyPower = enemyClusters.reduce((s,c) => s + c.size * 30, 0);
      localPowerBalance = Math.tanh((ourPower - enemyPower) / 100);
    }

    return [
      threat, baseHp, enemyNear, myArmy, enemyArmy, armyBalance, techLevel,
      resTotal, warehouseCount, turretCount, timeNorm, enemyTurrets, enemyElites,
      buildingDiversity, resourceEfficiency, expansionProgress, defenseStrength,
      gameTimeMinutes / 30.0, techStagnationPenalty, economyGap, armyGap, techGap, momentum, progressToWin,
      Math.min(1, estimatedIncomePerSec / 5.0),
      Math.min(1, 60 / timeToAffordWarehouse), isRichEnoughToExpand, isEconomyChoked,
      emptyWh, emptyRatio, income, enemyClusterThreat, ourClusterStrength,
      nearestEnemyClusterDist, flankOpportunity, localPowerBalance
    ];
  },

  // === Кластеризация юнитов в отряды ===
  clusterUnits: function(units, maxDist = 150) {
    const squads = [];
    for (const u of units) {
      let added = false;
      for (const squad of squads) {
        if (squad.baseType === u.type && squad.owner === u.owner) {
          const dist = Math.hypot(u.x - squad.x, u.y - squad.y);
          if (dist < maxDist) {
            squad.units.push(u);
            squad.count++;
            squad.x = squad.units.reduce((s, unit) => s + unit.x, 0) / squad.count;
            squad.y = squad.units.reduce((s, unit) => s + unit.y, 0) / squad.count;
            squad.hp = squad.units.reduce((s, unit) => s + (unit.health / (unit.maxHealth || 100)), 0) / squad.count;
            added = true;
            break;
          }
        }
      }
      if (!added) {
        squads.push({
          baseType: u.type,
          type: u.type + "_squad",
          owner: u.owner,
          units: [u],
          count: 1,
          x: u.x, y: u.y,
          hp: u.health / (u.maxHealth || 100),
          commandQueue: u.commandQueue || []
        });
      }
    }
    return squads;
  },

  // === Построение графа состояния ===
  buildGraphState: function () {
    if (!gameState || !aiBase || !aiBase.maxHealth || aiBase.maxHealth <= 0 || aiBase.health < 0) return null;
    const now = performance.now();
    const raw = [{ obj: aiBase, type: "base", owner: "ai", x: aiBase.x, y: aiBase.y, hp: Math.min(1, aiBase.health / aiBase.maxHealth), valid: 1, freshness: 1.0, isStale: false }];
    const candidates = [];
    const newlySeen = new Set();

    // ШАГ 1: Источники зрения
    const visionSources = [];
    for (const b of gameState.buildings) {
      if (b.owner === "ai" && b.health > 0) {
        let r = 300;
        if (b.type.startsWith("turret")) r = b.visionRadius || b.range || 400;
        else if (b.type.includes("base")) r = 400;
        else if (b.type === "beacon") r = 350;
        else if (b.type === "barracks") r = 320;
        else if (b.type === "warehouse") r = 250;
        visionSources.push({ x: b.x, y: b.y, r: r });
      }
    }
    for (const u of gameState.units) {
      if (u.owner === "ai" && u.health > 0) {
        let r = 350;
        if (u.type === "worker") r = 200;
        else if (u.type === "fighter") r = 300;
        else if (u.type === "assault") r = 350;
        else if (u.type === "elite") r = 400;
        visionSources.push({ x: u.x, y: u.y, r: r });
      }
    }
    const isVisible = (x, y) => {
      for (let i = 0; i < visionSources.length; i++) {
        const v = visionSources[i];
        if (Math.abs(x - v.x) <= v.r && Math.abs(y - v.y) <= v.r) {
          if (Math.hypot(x - v.x, y - v.y) <= v.r) return true;
        }
      }
      return false;
    };

    // ШАГ 2: Фильтрация через туман войны
    try {
      const allUnitsForClustering = [];
      for (const u of gameState.units) {
        if (!u || u.health <= 0 || !isFinite(u.x) || !isFinite(u.y)) continue;
        allUnitsForClustering.push(u);
      }
      const squads = this.clusterUnits(allUnitsForClustering, 150);
      for (const squad of squads) {
        const memKey = `squad_${squad.baseType}_${squad.owner}_${Math.round(squad.x)}_${Math.round(squad.y)}`;
        const isVisibleNow = isVisible(squad.x, squad.y);
        if (squad.owner === "ai" && ["fighter","assault","elite"].includes(squad.baseType)) {
          candidates.push({ obj: squad, type: squad.type, owner: squad.owner, x: squad.x, y: squad.y, hp: squad.hp, count: squad.count, valid: 1, freshness: 1.0, isStale: false });
          this.reconMemory.set(memKey, { obj: squad, type: squad.type, owner: squad.owner, x: squad.x, y: squad.y, hp: squad.hp, count: squad.count, lastSeen: now, isStale: false, isBuilding: false });
          continue;
        }
        if (squad.owner !== "ai" && ["fighter","assault","elite"].includes(squad.baseType)) {
          if (isVisibleNow) {
            newlySeen.add(memKey);
            this.reconMemory.set(memKey, { obj: squad, type: squad.type, owner: squad.owner, x: squad.x, y: squad.y, hp: squad.hp, count: squad.count, lastSeen: now, isStale: false, isBuilding: false });
            candidates.push({ obj: squad, type: squad.type, owner: squad.owner, x: squad.x, y: squad.y, hp: squad.hp, count: squad.count, valid: 1, freshness: 1.0, isStale: false });
          }
        }
      }

      for (const b of gameState.buildings) {
        if (!b || b.health <= 0 || b === aiBase || !isFinite(b.x) || !isFinite(b.y)) continue;
        const memKey = `building_${b.type}_${b.id}`;
        const isVisibleNow = isVisible(b.x, b.y);
        if (b.owner === "ai") {
          candidates.push({ obj: b, type: b.type, owner: b.owner, x: b.x, y: b.y, hp: b.health / (b.maxHealth || 1), valid: 1, freshness: 1.0, isStale: false });
          this.reconMemory.set(memKey, { obj: b, type: b.type, owner: b.owner, x: b.x, y: b.y, hp: b.health / (b.maxHealth || 1), lastSeen: now, isStale: false, isBuilding: true });
        } else {
          if (isVisibleNow) {
            newlySeen.add(memKey);
            this.reconMemory.set(memKey, { obj: b, type: b.type, owner: b.owner, x: b.x, y: b.y, hp: b.health / (b.maxHealth || 1), lastSeen: now, isStale: false, isBuilding: true });
            candidates.push({ obj: b, type: b.type, owner: b.owner, x: b.x, y: b.y, hp: b.health / (b.maxHealth || 1), valid: 1, freshness: 1.0, isStale: false });
          }
        }
      }

      for (const r of gameState.resources) {
        if (!r || r.amount <= 0) continue;
        const memKey = `resource_${r.type}_${Math.round(r.x)}_${Math.round(r.y)}`;
        const isVisibleNow = isVisible(r.x, r.y);
        if (isVisibleNow) {
          newlySeen.add(memKey);
          this.reconMemory.set(memKey, { obj: r, type: r.type, owner: "neutral", x: r.x, y: r.y, hp: r.amount / (r.max || 1), lastSeen: now, isStale: false, isBuilding: false });
          candidates.push({ obj: r, type: r.type, owner: "neutral", x: r.x, y: r.y, hp: r.amount / (r.max || 1), valid: 1, freshness: 1.0, isStale: false });
        }
      }
    } catch (e) { return null; }

    // ШАГ 3: Stale узлы из памяти
    const staleCandidates = [];
    for (const [key, mem] of this.reconMemory.entries()) {
      if (newlySeen.has(key)) continue;
      const age = now - mem.lastSeen;
      let maxAge = this.MAX_MEMORY_AGE || 60000;
      if (mem.isBuilding) maxAge = 90000;
      if (mem.type && mem.type.startsWith("turret")) maxAge = 120000;
      if (mem.owner === "player" && ["fighter","assault","elite"].includes(mem.type)) maxAge = 25000;
      if (age > maxAge) { this.reconMemory.delete(key); continue; }
      if (mem.obj && mem.obj.health !== undefined && mem.obj.health <= 0) { this.reconMemory.delete(key); continue; }
      const freshness = Math.max(0.1, 1.0 - (age / maxAge));
      staleCandidates.push({
        obj: mem.obj, type: mem.type, owner: mem.owner, x: mem.x, y: mem.y, hp: mem.hp,
        valid: 1, freshness: freshness, isStale: true, lastSeen: mem.lastSeen, isBuilding: mem.isBuilding || false
      });
    }
    staleCandidates.sort((a, b) => {
      let aP = 0, bP = 0;
      if (a.owner === "player") aP += 1000;
      if (b.owner === "player") bP += 1000;
      if (a.type && a.type.startsWith("turret")) aP += 800;
      if (b.type && b.type.startsWith("turret")) bP += 800;
      if (a.isBuilding) aP += 400;
      if (b.isBuilding) bP += 400;
      if (["fighter","assault","elite","base","barracks","warehouse"].includes(a.type)) aP += 300;
      if (["fighter","assault","elite","base","barracks","warehouse"].includes(b.type)) bP += 300;
      aP += a.freshness * 100;
      bP += b.freshness * 100;
      return bP - aP;
    });
    candidates.push(...staleCandidates.slice(0, 20));

    // ШАГ 4: Скоринг и заполнение графа
    const scoreObj = (o) => {
      let s = 10000;
      if (o.owner === "player") s += 5000;
      if (o.owner === "ai") s += 2500;
      if (["fighter","assault","elite"].includes(o.type)) {
        s += 3000;
        if (o.owner === "ai" && o.obj && o.obj.commandQueue && o.obj.commandQueue.length > 0) s += 2000;
      }
      if (o.type?.startsWith("turret")) s += 1600;
      if (["base","base2","base3","barracks","barracks2","barracks3","warehouse","repairWorkshop","beacon"].includes(o.type)) s += 1200;
      if (["gold","silicon","plasma"].includes(o.type)) s += 800 + (o.hp || 0) * 800;
      if (o.freshness !== undefined) s += o.freshness * 500;
      return s;
    };
    candidates.sort((a, b) => scoreObj(b) - scoreObj(a));
    for (const o of candidates.slice(0, CFG.MAX_NODES - 1)) {
      raw.push({
        obj: o.obj, type: o.type || "unknown", owner: o.owner || "none", x: o.x, y: o.y,
        hp: o.hp || 0, valid: 1, freshness: o.freshness !== undefined ? o.freshness : 1.0, isStale: o.isStale || false
      });
    }

    // Виртуальные узлы
    if (typeof this.generateVirtualNodes === "function") {
      const virtualNodes = this.generateVirtualNodes(raw);
      for (let i = 0; i < virtualNodes.length && raw.length < CFG.MAX_NODES - 4; i++) {
        raw.push(virtualNodes[i]);
      }
    }
    while (raw.length < CFG.MAX_NODES) {
      raw.push({ obj: null, type: "pad", owner: "none", x: 0, y: 0, hp: 0, valid: 0, freshness: 0, isStale: false });
    }

    const X = raw.map(n => this.nodeFeatures(n));
    const A_distance = [];
    const A_threat = [];
    for (let i = 0; i < CFG.MAX_NODES; i++) {
      const row_dist = [], row_threat = [];
      const ni = raw[i];
      for (let j = 0; j < CFG.MAX_NODES; j++) {
        const nj = raw[j];
        if (!ni.valid || !nj.valid) { row_dist.push(0); row_threat.push(0); continue; }
        if (i === j) { row_dist.push(1); row_threat.push(1); continue; }
        const d = Math.hypot(ni.x - nj.x, ni.y - nj.y);
        let geoConnection = 0;
        if (d <= CFG.INTERACTION_RADIUS) geoConnection = Math.exp(-d / CFG.INTERACTION_RADIUS);

        // Семантические связи
        let semanticConnection = 0;
        if (ni.type === "warehouse" && ["gold","silicon","plasma"].includes(nj.type)) {
          if (d < 400) semanticConnection = Math.max(semanticConnection, 0.9 * (1 - d / 400));
        }
        if (nj.type === "warehouse" && ["gold","silicon","plasma"].includes(ni.type)) {
          if (d < 400) semanticConnection = Math.max(semanticConnection, 0.9 * (1 - d / 400));
        }
        if (ni.type === "warehouse" && nj.type === "worker") semanticConnection = Math.max(semanticConnection, 0.85);
        if (nj.type === "warehouse" && ni.type === "worker") semanticConnection = Math.max(semanticConnection, 0.85);
        if (ni.type === "repairWorkshop" && nj.obj && nj.hp < 0.9) {
          if (d < 350) semanticConnection = Math.max(semanticConnection, 0.8 * (1 - nj.hp) * (1 - d / 350));
        }
        if (nj.type === "repairWorkshop" && ni.obj && ni.hp < 0.9) {
          if (d < 350) semanticConnection = Math.max(semanticConnection, 0.8 * (1 - ni.hp) * (1 - d / 350));
        }
        if (ni.type === "repairWorkshop" && nj.type === "repairman") semanticConnection = Math.max(semanticConnection, 0.9);
        if (nj.type === "repairWorkshop" && ni.type === "repairman") semanticConnection = Math.max(semanticConnection, 0.9);
        const productionLinks = {
          "barracks": ["fighter"], "barracks2": ["assault","fighter"], "barracks3": ["elite","assault","fighter"],
          "warehouse": ["worker"], "repairWorkshop": ["repairman"]
        };
        if (productionLinks[ni.type] && productionLinks[ni.type].includes(nj.type)) semanticConnection = Math.max(semanticConnection, 0.95);
        if (productionLinks[nj.type] && productionLinks[nj.type].includes(ni.type)) semanticConnection = Math.max(semanticConnection, 0.95);
        const turretRanges = { "turret": 250, "turret2": 500, "turret3": 450 };
        if (turretRanges[ni.type]) {
          const range = turretRanges[ni.type];
          if (d < range && !nj.type.startsWith("turret")) {
            let imp = 0.5;
            if (nj.type.includes("base")) imp = 1.0;
            else if (nj.type.includes("barracks")) imp = 0.8;
            else if (nj.type === "warehouse") imp = 0.7;
            semanticConnection = Math.max(semanticConnection, imp * (1 - d / range));
          }
        }
        if (turretRanges[nj.type]) {
          const range = turretRanges[nj.type];
          if (d < range && !ni.type.startsWith("turret")) {
            let imp = 0.5;
            if (ni.type.includes("base")) imp = 1.0;
            else if (ni.type.includes("barracks")) imp = 0.8;
            else if (ni.type === "warehouse") imp = 0.7;
            semanticConnection = Math.max(semanticConnection, imp * (1 - d / range));
          }
        }
        if ((ni.type === "beacon" || nj.type === "beacon")) {
          if (d < 300 && (ni.type.includes("base") || nj.type.includes("base") || ni.type === "beacon" || nj.type === "beacon")) {
            semanticConnection = Math.max(semanticConnection, 0.7 * (1 - d / 300));
          }
        }
        if ((ni.type.includes("base") || nj.type.includes("base"))) {
          if ((ni.type.includes("base") && !nj.type.includes("base")) || (nj.type.includes("base") && !ni.type.includes("base"))) {
            if (d < 500) semanticConnection = Math.max(semanticConnection, 0.6 * (1 - d / 500));
          }
        }
        if ((ni.type === "fighter" || ni.type === "assault" || ni.type === "elite") && nj.owner !== ni.owner) {
          if (nj.obj && nj.obj.commandQueue && nj.obj.commandQueue.length > 0) {
            const targetCmd = nj.obj.commandQueue.find(cmd => cmd.type === "attack");
            if (targetCmd && targetCmd.target === ni.obj) semanticConnection = Math.max(semanticConnection, 0.9);
          }
        }

        const finalConnection = Math.max(geoConnection, semanticConnection);
        row_dist.push(finalConnection);
        let threatValue = 0;
        if (ni.owner === "player" && nj.owner === "ai") {
          const enemyDps = this.getUnitDps(ni.type) || 0;
          if (d < 300) threatValue = (enemyDps / 100) * Math.exp(-d / 200);
        } else if (ni.owner === "ai" && nj.owner === "ai") {
          if (d < 200) threatValue = 0.5 * Math.exp(-d / 150);
        } else if (ni.owner === "ai" && nj.owner === "player") {
          const myDps = this.getUnitDps(ni.type) || 0;
          if (d < 250) threatValue = (myDps / 100) * Math.exp(-d / 200);
        }
        row_threat.push(Math.min(1, threatValue));
      }
      const sum_dist = row_dist.reduce((a, b) => a + b, 0) + 1e-9;
      const sum_threat = row_threat.reduce((a, b) => a + b, 0) + 1e-9;
      A_distance.push(row_dist.map(v => v / sum_dist));
      A_threat.push(row_threat.map(v => v / sum_threat));
    }
    return { X, A_distance, A_threat, nodes: raw };
  },

  // === Признаки узла (58 штук) ===
  nodeFeatures: function (n) {
    if (!n || !n.valid) return new Array(CFG.NODE_FEATURES).fill(0);
    const t = n.type || "";
    const isBuilding = typeof Building !== "undefined" && n.obj instanceof Building;
    const isResource = ["gold","silicon","plasma"].includes(t);
    const isCombat = ["fighter","assault","elite"].includes(t);
    const isTurret = typeof t === "string" && t.startsWith("turret");
    const wW = CFG.WORLD_WIDTH || 2000;
    const wH = CFG.WORLD_HEIGHT || 2000;
    const relX = (n.x - aiBase.x) / (wW * 0.5);
    const relY = (n.y - aiBase.y) / (wH * 0.5);
    const maxDist = Math.hypot(wW, wH);
    const dist = Math.hypot(n.x - aiBase.x, n.y - aiBase.y) / maxDist;
    const threat = n.owner === "player" ? (this._THREAT_ASSESSMENT[t] || 0) / 7 : 0;
    const isActive = n.obj && n.obj.active ? 1 : 0;
    const isUnderConstruction = n.obj && n.obj.builtAt && !n.obj.active ? 1 : 0;
    const isKeyBuilding = ["base","base2","base3","barracks","barracks2","barracks3","warehouse","beacon"].includes(t) ? 1 : 0;
    const isMilitary = isCombat || isTurret ? 1 : 0;
    const isEconomic = t === "warehouse" || t === "repairWorkshop" ? 1 : 0;
    const isExpansion = t === "base2" || t === "base3" || t === "beacon" ? 1 : 0;
    const techLevel = t === "base3" || t === "barracks3" || t === "turret3" ? 3 : (t === "base2" || t === "barracks2" || t === "turret2" ? 2 : 1);
    let isUnderAttack = 0;
    if (n.obj && n.obj.owner === "ai" && n.obj.health > 0) {
      if (gameState.units.some(u => u.owner === "player" && u.health > 0 && Math.hypot(u.x - n.obj.x, u.y - n.obj.y) < 150)) isUnderAttack = 1;
    }
    let isIdle = 0;
    if (n.obj && n.obj.owner === "ai" && isCombat) {
      if (!n.obj.commandQueue || n.obj.commandQueue.length === 0) isIdle = 1;
    }
    let logisticsScore = 0;
    if (t === "warehouse" && n.obj) {
      let minResDist = 9999;
      gameState.resources.forEach(r => {
        if (r.amount > 0) {
          const d = Math.hypot(r.x - n.obj.x, r.y - n.obj.y);
          if (d < minResDist) minResDist = d;
        }
      });
      logisticsScore = Math.max(0, 1.0 - (minResDist / 1000));
    }
    let buildingCategory = 0;
    if (isBuilding) {
      if (t === "warehouse") buildingCategory = 1;
      else if (t === "repairWorkshop") buildingCategory = 2;
      else if (t === "beacon" || t === "base2" || t === "base3") buildingCategory = 3;
      else if (t.startsWith("turret")) buildingCategory = 4;
      else if (t.startsWith("barracks")) buildingCategory = 5;
      else if (t === "base") buildingCategory = 6;
    }
    let workersOnBuilding = 0;
    if (t === "warehouse" && n.obj) workersOnBuilding = (n.obj.workers || 0) / (n.obj.maxDeliveryWorkers || 5);
    else if (t === "repairWorkshop" && n.obj) workersOnBuilding = (n.obj.repairman || 0) / (n.obj.capacity || 3);

    let nearestEnemyDist = 1.0;
    let enemyClusterNear = 0;
    let ourClusterStrength = 0;
    let hpRatio = n.hp || 0;
    let cooldownProgress = 1.0;
    let hasTarget = 0;
    let targetIsBuilding = 0;
    let targetHP = 0;
    let surrounded = 0;
    
    // === ИСПРАВЛЕНИЕ: ОБЪЯВЛЯЕМ ПЕРЕМЕННЫЕ ЗДЕСЬ, ДО ЛЮБЫХ IF ===
    let isRetreating = 0;
    let overkillRisk = 0;

    if (isCombat && n.obj) {
      const u = n.obj;
      hpRatio = u.health / (u.maxHealth || 1);
      cooldownProgress = u.attackCooldownMax > 0 ? 1.0 - (u.attackCooldown || 0) / u.attackCooldownMax : 1.0;

      // 1. Видит ли GNN, что движок включил панику?
      if (n.obj.isRetreating) isRetreating = 1;

      // 2. Оценивает ли GNN риск оверкилла по этой цели? (Если это враг)
      if (n.owner === "player" && n.obj) {
        const alliesAttacking = gameState.units.filter(u => 
          u.owner === "ai" && u.health > 0 && u.target === n.obj
        ).length;
        overkillRisk = Math.min(1, alliesAttacking / 3); // Нормализация 0..1
      }

      let minED = 9999, enemiesNear = 0, alliesNear = 0, allyPower = 0, enemyPower = 0;
      for (const other of gameState.units) {
        if (other === u || other.health <= 0) continue;
        const d = Math.hypot(other.x - u.x, other.y - u.y);
        if (d < 200) {
          if (other.owner === "player") { enemiesNear++; enemyPower += other.health + (this.getUnitDps(other.type) || 0) * 5; }
          else if (other.owner === "ai") { alliesNear++; allyPower += other.health + (this.getUnitDps(other.type) || 0) * 5; }
        }
        if (other.owner === "player" && d < minED) minED = d;
      }
      nearestEnemyDist = Math.min(1, minED / 400);
      enemyClusterNear = enemiesNear >= 3 ? 1 : 0;
      ourClusterStrength = Math.min(1, allyPower / 300);
      surrounded = (enemiesNear > alliesNear && enemiesNear >= 2) ? 1 : 0;
      if (u.commandQueue && u.commandQueue.length > 0) {
        hasTarget = 1;
        const cmd = u.commandQueue.find(c => c.type === "attack");
        if (cmd && cmd.target) {
          targetIsBuilding = ["base","base2","base3","warehouse","barracks","beacon","turret","turret2","turret3"].includes(cmd.target.type) ? 1 : 0;
          targetHP = cmd.target.health / (cmd.target.maxHealth || 1);
        }
      }
    }
    let targetPriority = 0;
    if (n.owner === "player" && n.type !== "gold" && n.type !== "silicon" && n.type !== "plasma") {
      if (n.type === "base" || n.type === "base2" || n.type === "base3") targetPriority = 1.0;
      else if (n.type === "warehouse") targetPriority = 0.85;
      else if (n.type === "barracks" || n.type === "barracks2" || n.type === "barracks3") targetPriority = 0.8;
      else if (n.type === "repairWorkshop") targetPriority = 0.75;
      else if (n.type === "beacon") targetPriority = 0.7;
      else if (n.type.startsWith("turret")) targetPriority = 0.6;
      else if (n.type === "worker") targetPriority = 0.5;
      else if (n.type === "fighter") targetPriority = 0.3;
      else if (n.type === "assault") targetPriority = 0.4;
      else if (n.type === "elite") targetPriority = 0.45;
    }
    let missionProgress = 0, missionStuck = 0, missionHitByTurret = 0, missionEfficiency = 0;
    if (isCombat && n.obj && n.obj.missionLog) {
      const ml = n.obj.missionLog;
      const targetStartHP = ml.targetStartHP || 1;
      missionProgress = Math.min(1, ml.damageDealt / targetStartHP);
      const elapsed = (performance.now() - ml.startTime) / 1000;
      missionStuck = (elapsed > 15 && ml.damageDealt < 10) ? 1 : 0;
      missionHitByTurret = ml.hitByTurret ? 1 : 0;
      missionEfficiency = Math.min(5, ml.damageDealt / Math.max(1, ml.damageTaken));
    }
    const freshness = n.freshness !== undefined ? n.freshness : 1.0;
    const isStale = n.isStale ? 1 : 0;
    const threatDensity = n.threatDensity !== undefined ? (n.threatDensity / 4) : 0;
    const isStagingArea = n.isStagingArea ? 1 : 0;

    return [
      n.valid ? 1 : 0,
      n.owner === "ai" ? 1 : 0,
      n.owner === "player" ? 1 : 0,
      n.hp || 0,
      (n.count !== undefined ? (n.count / 10) : 0),
      relX, relY, dist,
      isCombat ? 1 : 0, isBuilding ? 1 : 0, t === "worker" ? 1 : 0,
      t === "fighter" ? 1 : 0, t === "assault" ? 1 : 0, t === "elite" ? 1 : 0, t.startsWith("base") ? 1 : 0,
      isTurret ? 1 : 0, t === "warehouse" ? 1 : 0, t === "beacon" ? 1 : 0, isResource ? 1 : 0,
      isBuilding && (t === "warehouse" || t === "repairWorkshop") ? 1 : 0, t === "repairWorkshop" ? 1 : 0,
      threat,
      n.obj?.range ? Math.min(1, n.obj.range / 500) : 0,
      n.obj?.fireRate ? Math.min(1, 1000 / (n.obj.fireRate || 1)) : 0,
      this.strategicMemory.threatLevel / 30, isActive, isUnderConstruction, isKeyBuilding, isMilitary,
      isEconomic, isExpansion, techLevel / 3, isUnderAttack, isIdle, logisticsScore,
      (n.obj && n.obj.commandQueue && n.obj.commandQueue.length > 0) ? 1 : 0,
      (n.obj && n.obj.attackCooldown !== undefined && n.obj.attackCooldownMax && n.obj.attackCooldownMax > 0)
        ? 1.0 - (n.obj.attackCooldown / n.obj.attackCooldownMax) : 1.0,
      workersOnBuilding, nearestEnemyDist, enemyClusterNear, ourClusterStrength, hpRatio,
      cooldownProgress, hasTarget, targetIsBuilding, targetHP,
      surrounded, targetPriority,
      missionProgress, missionStuck, missionHitByTurret, missionEfficiency,
      freshness, isStale, threatDensity, isStagingArea, isRetreating, overkillRisk
    ].map(v => isFinite(v) ? v : 0);
  },

  // === Генерация виртуальных узлов ===
  generateVirtualNodes: function(nodes) {
    const virtualNodes = [];
    const enemyNodes = nodes.filter(n => n.valid && n.owner === "player");
    const aiNodes = nodes.filter(n => n.valid && n.owner === "ai");
    if (enemyNodes.length === 0) return virtualNodes;

    // 1. Зоны угрозы от турелей
    const enemyTurrets = enemyNodes.filter(n => n.type && n.type.startsWith("turret"));
    const TURRET_RANGE = { turret: 250, turret2: 500, turret3: 450 };
    enemyTurrets.forEach(turret => {
      const range = TURRET_RANGE[turret.type] || 250;
      virtualNodes.push({
        obj: null, type: "threat_zone", owner: "player",
        x: turret.x, y: turret.y, hp: 0, valid: 1,
        isVirtual: true, virtualType: "threat",
        threatRadius: range + 30, sourceTurret: turret.type,
        freshness: 1.0, isStale: false
      });
    });

    // 2. Фланговые точки
    let anchor = enemyNodes.find(n => n.type && n.type.includes("base"));
    if (!anchor && enemyTurrets.length > 0) {
      anchor = {
        x: enemyTurrets.reduce((s, t) => s + t.x, 0) / enemyTurrets.length,
        y: enemyTurrets.reduce((s, t) => s + t.y, 0) / enemyTurrets.length
      };
    }
    if (anchor) {
      const maxThreatR = virtualNodes
        .filter(v => v.virtualType === "threat")
        .reduce((mx, v) => Math.max(mx, Math.hypot(v.x - anchor.x, v.y - anchor.y) + v.threatRadius), 0);
      const TURRET_RANGES = { turret: 250, turret2: 500, turret3: 450 };
      const candidates = [];
      const numAngles = 16;
      for (let i = 0; i < numAngles; i++) {
        const angle = (i / numAngles) * Math.PI * 2;
        const searchDist = maxThreatR + 60;
        const fx = anchor.x + Math.cos(angle) * searchDist;
        const fy = anchor.y + Math.sin(angle) * searchDist;
        let threatCount = 0;
        enemyTurrets.forEach(t => {
          const distToTurret = Math.hypot(fx - t.x, fy - t.y);
          const tRange = TURRET_RANGES[t.type] || 250;
          if (distToTurret <= tRange) threatCount++;
        });
        candidates.push({ x: fx, y: fy, threatCount, angle });
      }
      candidates.sort((a, b) => a.threatCount - b.threatCount);
      const numToPlace = Math.min(4, candidates.length);
      for (let i = 0; i < numToPlace; i++) {
        const c = candidates[i];
        const isStagingArea = c.threatCount > 0;
        const finalDist = isStagingArea ? (maxThreatR + 150) : (maxThreatR + 60);
        const sx = anchor.x + Math.cos(c.angle) * finalDist;
        const sy = anchor.y + Math.sin(c.angle) * finalDist;
        const wW = typeof worldWidth !== 'undefined' ? worldWidth : 2000;
        const wH = typeof worldHeight !== 'undefined' ? worldHeight : 2000;
        if (sx < 50 || sy < 50 || sx > wW - 50 || sy > wH - 50) continue;
        virtualNodes.push({
          obj: null, type: "flank_point", owner: "neutral",
          x: sx, y: sy, hp: 0, valid: 1,
          isVirtual: true, virtualType: "flank",
          flankIndex: i, threatDensity: c.threatCount,
          isStagingArea: isStagingArea,
          freshness: 1.0, isStale: false
        });
      }
    }

    // 3. Точки разведки
    if (enemyNodes.length < 5) {
      const aiBaseNode = aiNodes.find(n => n.type === "base");
      if (aiBaseNode) {
        [Math.PI/4, Math.PI*0.75, Math.PI*1.25, Math.PI*1.75].forEach(angle => {
          virtualNodes.push({
            obj: null, type: "recon_target", owner: "neutral",
            x: aiBaseNode.x + Math.cos(angle) * 400,
            y: aiBaseNode.y + Math.sin(angle) * 400,
            hp: 0, valid: 1,
            isVirtual: true, virtualType: "recon",
            freshness: 0.5, isStale: false
          });
        });
      }
    }
    return virtualNodes;
  },

  // === Поиск лучшего кластера ресурсов ===
  findBestResourceCluster: function () {
    const res = gameState.resources.filter(r => r.amount > 20);
    let best = null, bestScore = 0;
    for (const r of res) {
      const covered = gameState.buildings.some(b =>
        b.owner === "ai" && b.type === "warehouse" && Math.hypot(b.x - r.x, b.y - r.y) < 320);
      if (covered) continue;
      const density = res.filter(o => Math.hypot(o.x - r.x, o.y - r.y) < 250)
        .reduce((s, o) => s + o.amount, 0);
      if (density > bestScore) { bestScore = density; best = r; }
    }
    return best;
  }

});