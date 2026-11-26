/**
 * AeronavHAHO - Modulo Meteo NOAA GFS (0.25°)
 * Recupera i venti in quota ai vari livelli barici direttamente dal modello NOAA GFS
 * tramite endpoint CORS-ready e calcola l'interpolazione vettoriale U/V per strato.
 */

export async function fetchNoaaGfsWindProfile(lat, lon, targetIsoHour = null) {
  const levels = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250];

  const hourlyVars = [
    "wind_speed_10m",
    "wind_direction_10m",
    ...levels.map(p => `wind_speed_${p}hPa`),
    ...levels.map(p => `wind_direction_${p}hPa`),
    ...levels.map(p => `geopotential_height_${p}hPa`)
  ].join(",");

  const url = `https://api.open-meteo.com/v1/gfs?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=${hourlyVars}&wind_speed_unit=kn&timezone=auto&forecast_days=2`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Errore NOAA GFS API: HTTP ${response.status}`);
  }

  const data = await response.json();
  const times = data.hourly.time;

  // Selezione dell'indice orario più vicino all'ora di lancio (o attuale)
  let timeIndex = 0;
  const referenceTime = targetIsoHour ? new Date(targetIsoHour).getTime() : Date.now();
  let minDiff = Infinity;

  times.forEach((t, idx) => {
    const diff = Math.abs(new Date(t).getTime() - referenceTime);
    if (diff < minDiff) {
      minDiff = diff;
      timeIndex = idx;
    }
  });

  const profile = [];
  const surfaceElevM = data.elevation || 0;
  const surfaceSpeedKts = data.hourly.wind_speed_10m[timeIndex];
  const surfaceDirDeg = data.hourly.wind_direction_10m[timeIndex];

  if (surfaceSpeedKts !== null && surfaceDirDeg !== null) {
    profile.push({
      pressure: "SFC",
      altM: Math.round(surfaceElevM),
      altFt: Math.round(surfaceElevM * 3.28084),
      dirDeg: Math.round(surfaceDirDeg),
      speedKts: Number(surfaceSpeedKts.toFixed(1)),
      speedMs: Number((surfaceSpeedKts * 0.514444).toFixed(2))
    });
  }

  for (const p of levels) {
    const geoHeightM = data.hourly[`geopotential_height_${p}hPa`]?.[timeIndex];
    const speedKts = data.hourly[`wind_speed_${p}hPa`]?.[timeIndex];
    const dirDeg = data.hourly[`wind_direction_${p}hPa`]?.[timeIndex];

    if (geoHeightM != null && geoHeightM > surfaceElevM + 30 && speedKts != null && dirDeg != null) {
      profile.push({
        pressure: p,
        altM: Math.round(geoHeightM),
        altFt: Math.round(geoHeightM * 3.28084),
        dirDeg: Math.round(dirDeg),
        speedKts: Number(speedKts.toFixed(1)),
        speedMs: Number((speedKts * 0.514444).toFixed(2))
      });
    }
  }

  profile.sort((a, b) => a.altFt - b.altFt);

  // Salvataggio backup locale per uso offline in quota
  const result = {
    model: "NOAA GFS 0.25°",
    validTime: times[timeIndex],
    fetchedAt: new Date().toISOString(),
    elevationM: surfaceElevM,
    layers: profile
  };

  try {
    localStorage.setItem("aeronav_last_noaa_profile", JSON.stringify(result));
  } catch (e) {
    console.warn("Impossibile salvare cache locale NOAA:", e);
  }

  return result;
}

/**
 * Interpolazione vettoriale (componenti U/V) tra due livelli barici NOAA GFS.
 * Evita artefatti sul passaggio 360° <-> 0°.
 */
export function getInterpolatedWindAtAltitude(layers, targetAltFt) {
  if (!layers || layers.length === 0) return { dirDeg: 0, speedKts: 0 };
  if (targetAltFt <= layers[0].altFt) {
    return { dirDeg: layers[0].dirDeg, speedKts: layers[0].speedKts };
  }
  if (targetAltFt >= layers[layers.length - 1].altFt) {
    const top = layers[layers.length - 1];
    return { dirDeg: top.dirDeg, speedKts: top.speedKts };
  }

  for (let i = 0; i < layers.length - 1; i++) {
    const low = layers[i];
    const high = layers[i + 1];

    if (targetAltFt >= low.altFt && targetAltFt <= high.altFt) {
      const ratio = (targetAltFt - low.altFt) / (high.altFt - low.altFt);

      const radLow = (low.dirDeg * Math.PI) / 180;
      const radHigh = (high.dirDeg * Math.PI) / 180;

      const uLow = -low.speedKts * Math.sin(radLow);
      const vLow = -low.speedKts * Math.cos(radLow);

      const uHigh = -high.speedKts * Math.sin(radHigh);
      const vHigh = -high.speedKts * Math.cos(radHigh);

      const uInterp = uLow + ratio * (uHigh - uLow);
      const vInterp = vLow + ratio * (vHigh - vLow);

      const speedKts = Math.hypot(uInterp, vInterp);
      let dirDeg = (Math.atan2(-uInterp, -vInterp) * 180) / Math.PI;
      if (dirDeg < 0) dirDeg += 360;

      return {
        dirDeg: Math.round(dirDeg),
        speedKts: Number(speedKts.toFixed(1))
      };
    }
  }
}

/**
 * Calcola la deriva integrata (vettore totale) dalla quota di apertura (o uscita) fino al DIP
 * suddividendo la discesa in strati da 1.000 ft.
 *
 * @param {Array} layers - Strati NOAA GFS restituiti da fetchNoaaGfsWindProfile
 * @param {number} exitAltFt - Quota di lancio/apertura (ft MSL)
 * @param {number} dipAltFt - Quota del DIP (ft MSL)
 * @param {number} verticalSpeedFpm - Rateo di discesa medio (ft/min, es. 1000-1200 ft/min)
 * @returns {{ driftDistanceM: number, driftBearingDeg: number, meanWindDirDeg: number, meanWindSpeedKts: number }}
 */
export function computeIntegratedDrift(layers, exitAltFt, dipAltFt, verticalSpeedFpm = 1000) {
  const stepFt = 1000;
  let totalU_ms = 0;
  let totalV_ms = 0;
  let totalTimeSec = 0;

  for (let alt = dipAltFt; alt < exitAltFt; alt += stepFt) {
    const topAlt = Math.min(alt + stepFt, exitAltFt);
    const layerHeightFt = topAlt - alt;
    const midAltFt = alt + layerHeightFt / 2;

    const timeSec = (layerHeightFt / verticalSpeedFpm) * 60;
    const wind = getInterpolatedWindAtAltitude(layers, midAltFt);
    const speedMs = wind.speedKts * 0.514444;
    const rad = (wind.dirDeg * Math.PI) / 180;

    // Vettore spostamento aria (verso dove soffia il vento)
    const u_ms = -speedMs * Math.sin(rad);
    const v_ms = -speedMs * Math.cos(rad);

    totalU_ms += u_ms * timeSec;
    totalV_ms += v_ms * timeSec;
    totalTimeSec += timeSec;
  }

  const driftDistanceM = Math.hypot(totalU_ms, totalV_ms);
  // Direzione verso cui deriva il paracadutista (downwind)
  let driftBearingDeg = (Math.atan2(totalU_ms, totalV_ms) * 180) / Math.PI;
  if (driftBearingDeg < 0) driftBearingDeg += 360;

  // Direzione di provenienza del vento medio balistico (upwind, per calcolo HARP)
  const meanWindDirDeg = (driftBearingDeg + 180) % 360;
  const meanWindSpeedKts = totalTimeSec > 0 ? (driftDistanceM / totalTimeSec) / 0.514444 : 0;

  return {
    driftDistanceM: Math.round(driftDistanceM),
    driftBearingDeg: Math.round(driftBearingDeg),
    meanWindDirDeg: Math.round(meanWindDirDeg),
    meanWindSpeedKts: Number(meanWindSpeedKts.toFixed(1))
  };
}
