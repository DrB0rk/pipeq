const DEFAULT_SAMPLE_RATE = 48000;

function magnitudeDb(numerator, denominator) {
  const [nr, ni] = numerator;
  const [dr, di] = denominator;
  return 20 * Math.log10(Math.max(1e-6, Math.hypot(nr, ni) / Math.hypot(dr, di)));
}

export function peakingResponseDb(band, frequency, sampleRate = DEFAULT_SAMPLE_RATE) {
  if (band.enabled === false || band.gain === 0) return 0;
  const center = 2 * Math.PI * band.freq / sampleRate;
  const cosCenter = Math.cos(center);
  const alpha = Math.sin(center) / (2 * Math.max(0.1, band.q));
  const amplitude = 10 ** (band.gain / 40);
  const b0 = 1 + alpha * amplitude;
  const b1 = -2 * cosCenter;
  const b2 = 1 - alpha * amplitude;
  const a0 = 1 + alpha / amplitude;
  const a1 = -2 * cosCenter;
  const a2 = 1 - alpha / amplitude;
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cos1 = Math.cos(omega);
  const sin1 = Math.sin(omega);
  const cos2 = Math.cos(2 * omega);
  const sin2 = Math.sin(2 * omega);
  return magnitudeDb(
    [b0 + b1 * cos1 + b2 * cos2, -b1 * sin1 - b2 * sin2],
    [a0 + a1 * cos1 + a2 * cos2, -a1 * sin1 - a2 * sin2],
  );
}

export function lowShelfResponseDb(gain, frequency, shelfFrequency = 120, sampleRate = DEFAULT_SAMPLE_RATE) {
  if (!gain) return 0;
  const amplitude = 10 ** (gain / 40);
  const center = 2 * Math.PI * shelfFrequency / sampleRate;
  const cosCenter = Math.cos(center);
  const alpha = Math.sin(center) * Math.SQRT1_2;
  const rootAmplitude = Math.sqrt(amplitude);
  const b0 = amplitude * ((amplitude + 1) - (amplitude - 1) * cosCenter + 2 * rootAmplitude * alpha);
  const b1 = 2 * amplitude * ((amplitude - 1) - (amplitude + 1) * cosCenter);
  const b2 = amplitude * ((amplitude + 1) - (amplitude - 1) * cosCenter - 2 * rootAmplitude * alpha);
  const a0 = (amplitude + 1) + (amplitude - 1) * cosCenter + 2 * rootAmplitude * alpha;
  const a1 = -2 * ((amplitude - 1) + (amplitude + 1) * cosCenter);
  const a2 = (amplitude + 1) + (amplitude - 1) * cosCenter - 2 * rootAmplitude * alpha;
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cos1 = Math.cos(omega);
  const sin1 = Math.sin(omega);
  const cos2 = Math.cos(2 * omega);
  const sin2 = Math.sin(2 * omega);
  return magnitudeDb(
    [b0 + b1 * cos1 + b2 * cos2, -b1 * sin1 - b2 * sin2],
    [a0 + a1 * cos1 + a2 * cos2, -a1 * sin1 - a2 * sin2],
  );
}

export function responseAtFrequency(state, frequency) {
  return state.preamp
    + lowShelfResponseDb(state.bassBoost, frequency)
    + state.bands.reduce((sum, band) => sum + peakingResponseDb(band, frequency), 0);
}
