(function (root) {
    'use strict';

    const notes = [[660, 0.12], [880, 0.16]];
    let audio;
    let lastPlayed = 0;

    async function play() {
        const now = Date.now();
        if (now - lastPlayed < 1200) return;
        lastPlayed = now;
        const Audio = root.AudioContext || root.webkitAudioContext;
        if (!Audio) return;

        try {
            audio ||= new Audio();
            if (audio.state === 'suspended') await audio.resume();
            let start = audio.currentTime + 0.015;
            for (const [frequency, length] of notes) {
                const note = audio.createOscillator();
                const envelope = audio.createGain();
                const end = start + length;
                note.frequency.value = frequency;
                note.connect(envelope);
                envelope.connect(audio.destination);
                const volume = envelope.gain;
                volume.setValueAtTime(0.0001, start);
                volume.exponentialRampToValueAtTime(0.075, start + 0.018);
                volume.exponentialRampToValueAtTime(0.0001, end);
                note.start(start);
                note.stop(end + 0.02);
                start = end;
            }
        } catch {
            // Sound may be unavailable until the browser allows audio playback.
        }
    }

    root.XiaomeiGenerationChime = { play };
})(window);
