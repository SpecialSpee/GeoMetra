// 05-training.js — Обучение: trainBatch(), _doTrainStep(),
"use strict";
Object.assign(window.GnnAI, {
  // Полный PPO/BC батч. Оставлен для совместимости.
  trainBatch: function () {
    if (this.training || this.isSaving || this.replay.length < CFG.BATCH_SIZE) return;
    if (!this.model || !this.vars || this.vars.length === 0) return;

    this.training = true;

    const batch = [];

    for (let i = 0; i < CFG.BATCH_SIZE; i++) {
      const sample = this.replay.getRandom();
      if (!sample) continue;

      const isXValid = sample.X && (
        (
          Array.isArray(sample.X) &&
          sample.X.length === CFG.MAX_NODES * CFG.NODE_FEATURES
        ) ||
        (
          Array.isArray(sample.X) &&
          Array.isArray(sample.X[0]) &&
          sample.X.length === CFG.MAX_NODES &&
          sample.X[0].length === CFG.NODE_FEATURES
        )
      );

      const isDistValid =
        sample.A_distance &&
        Array.isArray(sample.A_distance) &&
        sample.A_distance.length === CFG.MAX_NODES;

      const isThreatValid =
        sample.A_threat &&
        Array.isArray(sample.A_threat) &&
        sample.A_threat.length === CFG.MAX_NODES;

      const isActionValid =
        Number.isInteger(sample.actionIndex) &&
        sample.actionIndex >= 0 &&
        sample.actionIndex < G_ACTIONS.length;

      if (isXValid && isDistValid && isThreatValid && isActionValid && isFinite(sample.reward)) {
        batch.push(sample);
      }
    }

    if (batch.length < 4) {
      this.training = false;
      return;
    }

    // Добиваем батч до константного размера, чтобы TF.js не плодил разные shape-графы.
    while (batch.length < CFG.BATCH_SIZE) {
      batch.push(batch[Math.floor(Math.random() * batch.length)]);
    }

    const B = CFG.BATCH_SIZE;
    const saveEvery = CFG.SAVE_EVERY_BATCHES || 100;
    const shouldSave = (this.trainBatches + 1) % saveEvery === 0;

    tf.tidy(() => {
      try {
        const xs = tf.tensor3d(
          batch.map(b => b.X),
          [B, CFG.MAX_NODES, CFG.NODE_FEATURES]
        );

        const as_dist = tf.tensor3d(
          batch.map(b => b.A_distance),
          [B, CFG.MAX_NODES, CFG.MAX_NODES]
        );

        const as_threat = tf.tensor3d(
          batch.map(b => b.A_threat),
          [B, CFG.MAX_NODES, CFG.MAX_NODES]
        );

        const act = tf.tensor1d(
          batch.map(b => b.actionIndex),
          "int32"
        );

        const oldLogProbs = tf.tensor1d(
          batch.map(b => isFinite(b.oldLogProb) ? b.oldLogProb : -10.0),
          "float32"
        );

        const oldValues = tf.tensor1d(
          batch.map(b => isFinite(b.value) ? b.value : 0.0),
          "float32"
        );

        // Мягкий сквош наград + нормализация батча.
        const rewardsRaw = batch.map(b => {
          const r = isFinite(b.reward) ? Math.max(-1000, Math.min(1000, b.reward)) : 0;
          return Math.tanh(r / 100) * 10;
        });

        const meanR = rewardsRaw.reduce((a, b) => a + b, 0) / B;
        const variance = rewardsRaw.reduce((a, b) => a + (b - meanR) ** 2, 0) / B;
        const stdR = Math.sqrt(variance) + 1e-6;

        const rew = tf.tensor1d(
          rewardsRaw.map(r => (r - meanR) / stdR),
          "float32"
        );

        const masks = batch.map(b => {
          let m = b.actionMask;
          if (!m || m.length !== G_ACTIONS.length) {
            m = new Array(G_ACTIONS.length).fill(1);
          }
          return m;
        });

        const maskTensor = tf.tensor2d(masks, [B, G_ACTIONS.length]);

        const globalFeatures = this.getGlobalFeatures().map(v => isFinite(v) ? v : 0);
        const globalBatch = tf.tensor2d(
          Array(B).fill(globalFeatures),
          [B, CFG.GLOBAL_FEATURES]
        );

        const { value, grads } = tf.variableGrads(() => {
          const { logits, value } = this.model.forwardBatch(xs, as_dist, as_threat, globalBatch);

          const clippedValue = tf.clipByValue(value, -50, 50);

          const bcDen = CFG.BC_TRANSITION_BATCHES || 1000;
          const bcRatio = Math.max(0, 1 - (this.trainBatches / bcDen));

          // ВАЖНО: invalid actions должны получать -1e9, а не +1e9.
          const inverseMask = tf.scalar(1).sub(maskTensor).mul(-1e9);
          const maskedLogits = logits.add(inverseMask);

          const logProbs = tf.log(tf.softmax(maskedLogits).add(1e-10));
          const oneHot = tf.oneHot(act, G_ACTIONS.length);
          const newLogProbs = logProbs.mul(oneHot).sum(1);

          const values = clippedValue.squeeze();
          const advantage = rew.sub(values);

          const ratio = tf.exp(newLogProbs.sub(oldLogProbs));
          const clippedRatio = tf.clipByValue(
            ratio,
            1 - CFG.CLIP_EPSILON,
            1 + CFG.CLIP_EPSILON
          );

          const surrogate1 = ratio.mul(advantage);
          const surrogate2 = clippedRatio.mul(advantage);
          const actorLoss = tf.minimum(surrogate1, surrogate2).mul(-1).mean();

          const valueClipped = oldValues.add(
            tf.clipByValue(values.sub(oldValues), -0.5, 0.5)
          );

          const criticLoss1 = values.sub(rew).square();
          const criticLoss2 = valueClipped.sub(rew).square();
          const criticLoss = tf.maximum(criticLoss1, criticLoss2).mean();

          const probs = tf.softmax(maskedLogits);
          const entropy = probs.mul(logProbs).mul(-1).sum(1).mean();

          let totalLoss;
          const hasExpertData = batch.some(b => b.isExpert);

          if (bcRatio > 0.1 || hasExpertData) {
            const bcLoss = logProbs.mul(oneHot).sum(1).mul(-1).mean();
            const expertWeight = hasExpertData ? 2.0 : 1.0;

            totalLoss = bcLoss
              .mul(bcRatio * expertWeight)
              .add(actorLoss.mul(1 - bcRatio))
              .add(criticLoss.mul(0.5));
          } else {
            if (this.bcActive) {
              console.log("[GnnAI] 🎓 BC завершен. Full PPO mode.");
              this.bcActive = false;
            }

            const currentEntropyCoef = this.getEntropyCoef();
            totalLoss = actorLoss
              .add(criticLoss.mul(0.5))
              .sub(entropy.mul(currentEntropyCoef));
          }

          return totalLoss;
        }, this.vars);

        // Клиппинг градиентов по общей норме.
        const gradValues = this.vars.map(v => grads[v.name]).filter(Boolean);
        let clipCoef = 1.0;
        let normVal = 0; // 🔥 Объявляем переменную заранее

        if (gradValues.length > 0) {
          const sumSquares = gradValues.map(g => g.square().sum());
          const globalNorm = tf.addN(sumSquares).sqrt();
          normVal = globalNorm.dataSync()[0]; // 🔥 Сохраняем значение

          clipCoef = Math.min(
            1.0,
            (CFG.GRADIENT_CLIP_NORM || 5.0) / (normVal + 1e-8)
          );
          sumSquares.forEach(t => t.dispose());
          globalNorm.dispose();
        }

        const finalGrads = {};
        this.vars.forEach(v => {
          const g = grads[v.name];
          finalGrads[v.name] = g ? g.mul(clipCoef) : tf.zerosLike(v);
        });

        this.optimizer.applyGradients(finalGrads);

        this.vars.forEach(v => {
          if (grads[v.name]) grads[v.name].dispose();
          if (finalGrads[v.name]) finalGrads[v.name].dispose();
        });

        const lossVal = value.dataSync()[0];
        value.dispose();

        // 🔥 СБОР ДАННЫХ ДЛЯ ГРАФИКА (исправлено: lossVal уже определен)
        if (!this.gradHistory) this.gradHistory = [];
        this.gradHistory.push({
          batch: this.trainBatches + 1,
          loss: isFinite(lossVal) ? lossVal : NaN,
          gradNorm: normVal
        });
        if (this.gradHistory.length > 60) this.gradHistory.shift();

        if (!isFinite(lossVal)) {
          console.error("[GnnAI] ❌ Loss стал NaN! Сброс...");
          this.training = false;
          setTimeout(() => this.reset(), 0);
          return;
        }

        this.trainBatches++;

        if (this.trainBatches % 10 === 0) {
          const mem = tf.memory();
          console.log(
            `[GnnAI Train] Batch: ${this.trainBatches}, ` +
            `Loss: ${lossVal.toFixed(4)}, ` +
            `GPU: ${(mem.numBytes / 1024 / 1024).toFixed(1)} MB, ` +
            `Tensors: ${mem.numTensors}`
          );
        }

        this.updateTargetNetwork();
      } catch (e) {
        console.error("[GnnAI] train error", e);
      } finally {
        this.training = false;
      }
    });

    // Сохранение вне tf.tidy.
    if (shouldSave && !this._saveScheduled) {
      this.isSaving = true;
      this._saveScheduled = true;  // 🔥 Помечаем, что сохранение запланировано
      setTimeout(() => {
        Promise.resolve(this.saveWeights())
          .catch(e => console.error("[GnnAI] save error:", e))
          .finally(() => { 
            this.isSaving = false;
            this._saveScheduled = false;  // 🔥 Сбрасываем флаг
          });
      }, 100);
    } else {
      this.isSaving = false;
    }
  },
  // Лёгкий обучающий шаг по кадрам (ПОЛНАЯ ЗАМЕНА С ДЕТЕКТОРОМ ОШИБОК)
  _doTrainStep: function () {
    if (!this._trainStepsPending || this._trainStepsPending <= 0) return;
    if (!this.model || !this.vars || this.vars.length === 0) return;

    if (this.training || this.isSaving) {
      requestAnimationFrame(() => this._doTrainStep());
      return;
    }

    this._trainStepsPending--;
    this.training = true;

    tf.tidy(() => {
      try {
        const miniBatch = [];
        const miniSize = Math.min(8, this.replay.length);
        
        for (let i = 0; i < miniSize; i++) {
          const sample = this.replay.getRandom();
          if (
            sample &&
            sample.X &&
            sample.A_distance &&
            sample.A_threat &&
            Number.isInteger(sample.actionIndex) &&
            sample.actionIndex >= 0 &&
            sample.actionIndex < G_ACTIONS.length &&
            isFinite(sample.reward)
          ) {
            miniBatch.push(sample);
          }
        }

        if (miniBatch.length < 4) return;

        while (miniBatch.length < 8) {
          miniBatch.push(miniBatch[Math.floor(Math.random() * miniBatch.length)]);
        }

        const B = 8;
        const xs = tf.tensor3d(miniBatch.map(b => b.X), [B, CFG.MAX_NODES, CFG.NODE_FEATURES]);
        const as_dist = tf.tensor3d(miniBatch.map(b => b.A_distance), [B, CFG.MAX_NODES, CFG.MAX_NODES]);
        const as_threat = tf.tensor3d(miniBatch.map(b => b.A_threat), [B, CFG.MAX_NODES, CFG.MAX_NODES]);
        const act = tf.tensor1d(miniBatch.map(b => b.actionIndex), "int32");
        const rew = tf.tensor1d(miniBatch.map(b => {
          const r = isFinite(b.reward) ? Math.max(-1000, Math.min(1000, b.reward)) : 0;
          return Math.tanh(r / 100) * 10;
        }), "float32");
        const oldLogProbs = tf.tensor1d(miniBatch.map(b => isFinite(b.oldLogProb) ? b.oldLogProb : -10.0), "float32");
        const oldValues = tf.tensor1d(miniBatch.map(b => isFinite(b.value) ? b.value : 0.0), "float32");
        const maskTensor = tf.tensor2d(miniBatch.map(b => {
          let m = b.actionMask;
          if (!m || m.length !== G_ACTIONS.length) m = new Array(G_ACTIONS.length).fill(1);
          return m;
        }), [B, G_ACTIONS.length]);

        const globalFeatures = this.getGlobalFeatures().map(v => isFinite(v) ? v : 0);
        const globalBatch = tf.tensor2d(Array(B).fill(globalFeatures), [B, CFG.GLOBAL_FEATURES]);

        const { value, grads } = tf.variableGrads(() => {
          const { logits, value } = this.model.forwardBatch(xs, as_dist, as_threat, globalBatch);
          const clippedValue = tf.clipByValue(value, -50, 50);
          const inverseMask = tf.scalar(1).sub(maskTensor).mul(-1e9);
          const maskedLogits = logits.add(inverseMask);
          const logProbs = tf.log(tf.softmax(maskedLogits).add(1e-10));
          const oneHot = tf.oneHot(act, G_ACTIONS.length);
          const newLogProbs = logProbs.mul(oneHot).sum(1);
          const values = clippedValue.squeeze();
          const advantage = rew.sub(values);
          const ratio = tf.exp(newLogProbs.sub(oldLogProbs));
          const clippedRatio = tf.clipByValue(ratio, 1 - CFG.CLIP_EPSILON, 1 + CFG.CLIP_EPSILON);
          const surrogate1 = ratio.mul(advantage);
          const surrogate2 = clippedRatio.mul(advantage);
          const actorLoss = tf.minimum(surrogate1, surrogate2).mul(-1).mean();
          const valueClipped = oldValues.add(tf.clipByValue(values.sub(oldValues), -0.5, 0.5));
          const criticLoss1 = values.sub(rew).square();
          const criticLoss2 = valueClipped.sub(rew).square();
          const criticLoss = tf.maximum(criticLoss1, criticLoss2).mean();
          const probs = tf.softmax(maskedLogits);
          const entropy = probs.mul(logProbs).mul(-1).sum(1).mean();
          const currentEntropyCoef = this.getEntropyCoef();
          return actorLoss.add(criticLoss.mul(0.5)).sub(entropy.mul(currentEntropyCoef));
        }, this.vars);

        const gradValues = this.vars.map(v => grads[v.name]).filter(Boolean);
        let clipCoef = 1.0;
        let normVal = 0;

        if (gradValues.length > 0) {
          const sumSquares = gradValues.map(g => g.square().sum());
          const globalNorm = tf.addN(sumSquares).sqrt();
          normVal = globalNorm.dataSync()[0];
          clipCoef = Math.min(1.0, (CFG.GRADIENT_CLIP_NORM || 5.0) / (normVal + 1e-8));
          sumSquares.forEach(t => t.dispose());
          globalNorm.dispose();
        }

        const finalGrads = {};
        this.vars.forEach(v => {
          const g = grads[v.name];
          finalGrads[v.name] = g ? g.mul(clipCoef) : tf.zerosLike(v);
        });

        this.optimizer.applyGradients(finalGrads);
        this.vars.forEach(v => {
          if (grads[v.name]) grads[v.name].dispose();
          if (finalGrads[v.name]) finalGrads[v.name].dispose();
        });

        const lossVal = value.dataSync()[0];
        value.dispose();

        // Сбор данных для графика
        if (!this.gradHistory) this.gradHistory = [];
        this.gradHistory.push({
          batch: this.trainBatches + 1,
          loss: isFinite(lossVal) ? lossVal : NaN,
          gradNorm: normVal
        });
        if (this.gradHistory.length > 60) this.gradHistory.shift();

        if (isFinite(lossVal)) {
          this.trainBatches++;
          
          // 🔥 Target network обновляем РАЗ В 20 БАТЧЕЙ (было 10)
          if (this.trainBatches % 20 === 0) {
            this.updateTargetNetwork();
          }
          
          if (this.trainBatches % 10 === 0) {
            console.log(`[GnnAI] Mini-batch ${this.trainBatches}, Loss: ${lossVal.toFixed(4)}, GradNorm: ${normVal.toFixed(4)}`);
          }
          
          const saveEvery = CFG.SAVE_EVERY_BATCHES || 50;
          if (this.trainBatches % saveEvery === 0 && !this.isSaving && !this._saveScheduled) {
            this.isSaving = true;
            this._saveScheduled = true;  // 🔥 Помечаем, что сохранение запланировано
            setTimeout(() => {
              Promise.resolve(this.saveWeights())
                .catch(e => console.error("[GnnAI] mini-save error:", e))
                .finally(() => { 
                  this.isSaving = false;
                  this._saveScheduled = false;  // 🔥 Сбрасываем флаг
                });
            }, 100);
          }
        } else {
          console.error("[GnnAI] ❌ Mini-batch Loss NaN/Inf.");
        }
      } catch (e) {
        console.error("[GnnAI] train step error", e);
      } finally {
        this.training = false;
      }
    });

    if (this._trainStepsPending > 0) {
      requestAnimationFrame(() => this._doTrainStep());
    }
  },
  // Мягкое обновление target-сети.
  updateTargetNetwork: function () {
    if (!this.targetVars || !this.vars || this.vars.length !== this.targetVars.length) return;

    tf.tidy(() => {
      for (let i = 0; i < this.vars.length; i++) {
        const v = this.vars[i];
        const tv = this.targetVars[i];
        const updated = v.mul(this.tau).add(tv.mul(1 - this.tau));
        tv.assign(updated);
      }
    });
  },
    // === ХЕЛПЕР: время МАТЧА в минутах (не страницы!) ===
  gameTimeMin: function () {
    const start = this.matchStartTime || performance.now();
    return (performance.now() - start) / 60000;
  },
  // === ДИНАМИЧЕСКАЯ ЭНТРОПИЯ ===
  getEntropyCoef: function () {
    const m = this.metrics();
    const gameTimeMin = this.gameTimeMin(); // 🔥 ВРЕМЯ МАТЧА

    // ФАЗА 1: Ранняя игра — минимальная энтропия, учим экономику
    if (gameTimeMin < 2.5 || m.aiWarehouses < 2) {
      return 0.01; // 🎯 Exploit
    }

    // ФАЗА 2: Середина игры — есть армия, исследуем тактики
    if (gameTimeMin < 7.0 && m.aiArmy >= 2) {
      return CFG.ENTROPY_COEF || 0.08; // 🔍 Explore
    }

    // ФАЗА 3: Поздняя игра — точность
    if (gameTimeMin >= 7.0 || m.techLevel >= 3) {
      return 0.02; // 🎯 Exploit
    }

    // Переходная зона: склады есть, армии ещё нет — мягкий режим
    return 0.03;
  },
  // Статистика весов для UI/отладки.
  calculateWeightStats: function () {
    if (!this.vars || this.vars.length === 0) return null;

    let totalWeights = 0;
    let sum = 0;
    let sumSq = 0;
    let min = Infinity;
    let max = -Infinity;
    let l2Norm = 0;

    for (const v of this.vars) {
      const data = v.dataSync();

      for (let i = 0; i < data.length; i++) {
        const val = data[i];
        if (!isFinite(val)) continue;

        sum += val;
        sumSq += val * val;

        if (val < min) min = val;
        if (val > max) max = val;

        l2Norm += val * val;
        totalWeights++;
      }
    }

    if (totalWeights === 0) {
      return {
        count: 0,
        avg: 0,
        min: 0,
        max: 0,
        std: 0,
        l2: 0,
        deltaSession: 0,
        deltaSave: 0,
        timestamp: performance.now()
      };
    }

    const avg = sum / totalWeights;
    const variance = (sumSq / totalWeights) - (avg * avg);
    const std = Math.sqrt(Math.max(0, variance));
    const currentL2 = Math.sqrt(l2Norm);

    let deltaSession = 0;
    if (this.sessionStartL2 && this.sessionStartL2 > 0) {
      deltaSession = ((currentL2 - this.sessionStartL2) / this.sessionStartL2) * 100;
    }

    let deltaSave = 0;
    if (this.lastWeightSnapshot && isFinite(this.lastWeightSnapshot.l2)) {
      const diff = Math.abs(currentL2 - this.lastWeightSnapshot.l2);
      deltaSave = Math.min(
        100,
        (diff / (this.lastWeightSnapshot.l2 + 1e-8)) * 100
      );
    }

    const stats = {
      count: totalWeights,
      avg,
      min,
      max,
      std,
      l2: currentL2,
      deltaSession,
      deltaSave,
      timestamp: performance.now()
    };

    this.currentWeightStats = stats;
    this.lastStatsUpdate = performance.now();

    return stats;
  }
});