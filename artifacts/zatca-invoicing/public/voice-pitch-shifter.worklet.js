class VoicePitchShifter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 4096;
    this.range = 2048;
    this.minimumDelay = 32;
    this.buffers = [];
    this.writeIndex = 0;
    this.phase = 0;
  }

  static get parameterDescriptors() {
    return [{ name: "semitones", defaultValue: 0, minValue: -12, maxValue: 12, automationRate: "k-rate" }];
  }

  read(buffer, delay) {
    let position = this.writeIndex - delay;
    while (position < 0) position += this.size;
    const index = Math.floor(position) % this.size;
    const next = (index + 1) % this.size;
    const fraction = position - Math.floor(position);
    return buffer[index] * (1 - fraction) + buffer[next] * fraction;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;
    while (this.buffers.length < Math.max(input.length, output.length)) this.buffers.push(new Float32Array(this.size));

    const semitones = parameters.semitones.length ? parameters.semitones[0] : 0;
    const ratio = Math.pow(2, semitones / 12);
    const phaseStep = (1 - ratio) / this.range;

    for (let sample = 0; sample < output[0].length; sample += 1) {
      for (let channel = 0; channel < output.length; channel += 1) {
        const source = input[channel] || input[0];
        const buffer = this.buffers[channel];
        buffer[this.writeIndex] = source[sample] || 0;
        if (Math.abs(semitones) < 0.03) {
          output[channel][sample] = source[sample] || 0;
          continue;
        }

        const phaseA = (this.phase + 1) % 1;
        const phaseB = (phaseA + 0.5) % 1;
        const delayA = this.minimumDelay + phaseA * this.range;
        const delayB = this.minimumDelay + phaseB * this.range;
        const weightA = 0.5 - 0.5 * Math.cos(2 * Math.PI * phaseA);
        const weightB = 1 - weightA;
        output[channel][sample] = this.read(buffer, delayA) * weightA + this.read(buffer, delayB) * weightB;
      }
      this.writeIndex = (this.writeIndex + 1) % this.size;
      this.phase = (this.phase + phaseStep) % 1;
      if (this.phase < 0) this.phase += 1;
    }
    return true;
  }
}

registerProcessor("voice-pitch-shifter", VoicePitchShifter);
