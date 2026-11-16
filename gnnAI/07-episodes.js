// ============================================================
// 07-episodes.js — Эпизоды: startEpisode, finishEpisode,
//                  benchmarkTick, readStats, stats, checkEnd,
//                  printEpisodeReport
// ============================================================
"use strict";

Object.assign(window.GnnAI, {

  // === Старт эпизода ===
  startEpisode: function (mode) {
    if (CFG.BC_MODE) {
      this.bcActive = true;
      this.bcBatchCount = 0;
    }
    this.episode = {
      mode, start: performance.now(),
      firstThreatAt: null, firstDefenseAt: null,
      minBaseHp: 1, actions: {}, ended: false, result: null
    };
    this.episodeReport = { actions: {}, timeline: [] };

    // Сброс кредит-ассайнмента
    this.lastReplayEntry = null;
    this._pendingShaped = 0;
    this.lastTechStagnationCheck = 0;
    this._lastRewardedTechLevel = 1;
    this._lastKnownTechLevel = 1;
    this._lastTierTransitionTime = 0;
    this._lastOutpostCount = 0;
    this._lastArmyPositions = null;
    this._lastKillCount = 0;
    this._lastDeathCount = 0;
    this._lastDamageDealt = 0;
    this._lastDamageTaken = 0;

    this.episodeAchievements = {
      firstBarracks: false, firstBase2: false, firstBarracks2: false,
      firstBase3: false, firstAssault: false, firstElite: false,
      firstBeacon: false
    };
  },

  // === Тик бенчмарка ===
  benchmarkTick: function (mode, action) {
    if (gameMode !== mode || !this.episode || this.episode.mode !== mode || this.episode.ended) return;
    const m = this.metrics();
    const now = performance.now();
    this.episode.minBaseHp = Math.min(this.episode.minBaseHp, m.baseHp);
    if (action) this.episode.actions[action] = (this.episode.actions[action] || 0) + 1;
    if (this.episode.firstThreatAt === null && m.enemyNear > 0) this.episode.firstThreatAt = now;
  },

  // === Завершение эпизода ===
  finishEpisode: function (result) {
    if (!this.episode || this.episode.ended) return;
    this.episode.ended = true;
    this.episode.result = result;
    this.episode.duration = performance.now() - this.episode.start;

    // Финальная награда за результат матча
    const finalReward = (result === "win") ? 500.0 : -500.0;
    if (this.lastState) {
      this.replay.push({
        X: this.lastState.X,
        A_distance: this.lastState.A_distance,
        A_threat: this.lastState.A_threat,
        actionIndex: this._AIDX.idle,
        reward: finalReward
      });
      if (result === "win") {
        console.log(`[GnnAI] 🏆 ПОБЕДА! Финальная награда: +${finalReward.toFixed(1)}`);
      } else {
        console.warn(`[GnnAI] 💀 ПОРАЖЕНИЕ! Финальный штраф: ${finalReward.toFixed(1)}`);
      }
    }

    // CURRICULUM PROGRESSION
    if (result === "win") {
      this.episodesInCurrentTier++;
      let shouldAdvance = false;
      if (this.curriculumTier === 0 && this.tierGoalsMet.barracks) shouldAdvance = true;
      if (this.curriculumTier === 1 && this.tierGoalsMet.base2) shouldAdvance = true;
      if (this.curriculumTier === 2 && this.tierGoalsMet.base3) shouldAdvance = true;
      if (this.episodesInCurrentTier >= this.TIER_THRESHOLD) shouldAdvance = true;
      if (shouldAdvance && this.curriculumTier < 3) {
        this.curriculumTier++;
        this.episodesInCurrentTier = 0;
        console.log(`[Curriculum] 🎓 Уровень повышен до Tier ${this.curriculumTier}!`);
      }
    }

    const row = {
      mode: this.episode.mode, result, date: new Date().toISOString(),
      durationSec: +(this.episode.duration / 1000).toFixed(2),
      minBaseHp: +this.episode.minBaseHp.toFixed(3), actions: { ...this.episode.actions }
    };
    const stats = this.readStats();
    stats.push(row);
    while (stats.length > 80) stats.shift();
    localStorage.setItem(CFG.STATS_KEY, JSON.stringify(stats));
    console.log("[GnnAI benchmark] saved", row);

    this.printEpisodeReport(result);
    this.stats();
  },

  // === Чтение статистики ===
  readStats: function () {
    try { return JSON.parse(localStorage.getItem(CFG.STATS_KEY) || "[]"); } catch { return []; }
  },

  // === Вывод сводной статистики ===
  stats: function () {
    const rows = this.readStats();
    const by = {};
    for (const r of rows) { if (!by[r.mode]) by[r.mode] = []; by[r.mode].push(r); }
    const summary = {};
    for (const mode of Object.keys(by)) {
      const list = by[mode];
      const hp = list.map(x => x.minBaseHp).filter(x => typeof x === "number");
      const wins = list.filter(x => x.result === "win").length;
      summary[mode] = {
        episodes: list.length, wins,
        winRate: +(wins / list.length).toFixed(3),
        avgMinBaseHp: hp.length ? +(hp.reduce((a, b) => a + b, 0) / hp.length).toFixed(3) : null
      };
    }
    console.table(summary);
    return summary;
  },

  // === Проверка конца игры ===
  checkEnd: async function () {
    if (gameState.gameEnded) return;
    const aiBaseAlive = gameState.buildings.some(b => b.owner === "ai" && b.type === "base" && b.health > 0);
    const playerBaseAlive = gameState.buildings.some(b => b.owner === "player" && b.type === "base" && b.health > 0);

    if (!aiBaseAlive || !playerBaseAlive) {
      gameState.gameEnded = true;
      console.log("[GnnAI] 💾 Игра завершена. Сохранение весов...");

      try {
        await this.saveWeights();
        console.log("[GnnAI] ✅ Веса успешно сохранены перед завершением матча");
      } catch (e) {
        console.error("[GnnAI] ❌ Ошибка сохранения весов:", e);
        try {
          const backup = this.vars.map(v => ({
            shape: v.shape,
            values: Array.from(v.dataSync()).filter(isFinite)
          }));
          localStorage.setItem(CFG.STORAGE_KEY + '_backup', JSON.stringify({
            version: 7.7,
            batches: this.trainBatches,
            data: { main: backup },
            timestamp: Date.now()
          }));
          console.log("[GnnAI] 💾 Резервная копия сохранена в localStorage");
        } catch (e2) {
          console.error("[GnnAI] ❌ Даже резервное сохранение не удалось:", e2);
        }
      }

      await new Promise(r => setTimeout(r, 500));

      if (!aiBaseAlive) this.finishEpisode("loss");
      else this.finishEpisode("win");

      if (window.autoRestartEnabled) {
        setTimeout(() => {
          console.log("[Curriculum] 🔄 Перезагрузка страницы для 100% чистой новой игры...");
          localStorage.setItem('gnn_auto_restart', 'true');
          window.location.reload();
        }, 2000);
      } else {
        if (typeof showVictoryScreen === "function") {
          showVictoryScreen(!aiBaseAlive ? "GNN ИИ проиграл." : "GNN ИИ победил!");
        }
      }
    }
  },

  // === Отчёт о матче ===
  printEpisodeReport: function (result) {
    console.group(`📊 [GnnAI] ПОЛНЫЙ ОТЧЕТ О МАТЧЕ: ${result.toUpperCase()}`);
    if (!this.episodeReport) { console.groupEnd(); return; }
    console.log("🎯 Общее распределение действий:", this.episodeReport.actions);

    const keyEvents = this.episodeReport.timeline.filter(e =>
      e.detail === "barracks" || e.detail === "barracks2" || e.detail === "barracks3" ||
      e.detail === "base2" || e.detail === "base3" || e.detail === "warehouse" ||
      e.detail === "repairWorkshop" || e.detail === "beacon" ||
      e.detail === "fighter" || e.detail === "assault" || e.detail === "elite" ||
      e.action === "attack_front" || e.action === "attack_flank" || e.action === "attack_feint"
    );
    if (keyEvents.length > 0) {
      console.log("🏗️ Ключевые события (постройки, найм, атаки):");
      console.table(keyEvents, ["time", "action", "detail", "resources", "army", "tech"]);
    } else {
      console.log("⚠️ Ключевых событий не зафиксировано.");
    }

    const m = this.metrics();
    console.log(`💰 Финальная экономика: Ресурсы: ${m.resTotal}, Армия: ${m.aiArmy}, Технологий: Тир ${m.techLevel}`);
    console.groupEnd();
  }

});