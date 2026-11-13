const encoder = new TextEncoder();
const crcTable = Uint32Array.from({length: 256}, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    return crc;
});

function crcOf(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    return (crc ^ 0xffffffff) >>> 0;
}

function header(size, fields) {
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    for (const [at, value, wide] of fields) {
        if (wide) view.setUint32(at, value, true);
        else view.setUint16(at, value, true);
    }
    return bytes;
}

export function zipFiles(files) {
    const body = [], directory = [];
    const names = new Set();
    let offset = 0, directorySize = 0;
    for (const file of files) {
        const parts = /^(.*?)(\.[^.]+)?$/.exec(file.name);
        let name = file.name;
        for (let suffix = 2; names.has(name.toLowerCase()); suffix++) {
            name = `${parts[1]}-${suffix}${parts[2] || ''}`;
        }
        names.add(name.toLowerCase());
        const label = encoder.encode(name);
        const size = file.bytes.length;
        if (offset + size + label.length + 30 > 0xffffffff || label.length > 65535 || names.size > 65535) {
            throw new Error('ZIP 太大，请分批下载');
        }
        const crc = crcOf(file.bytes);
        body.push(header(30, [
            [0, 0x04034b50, true], [4, 20], [6, 0x0800], [12, 33],
            [14, crc, true], [18, size, true], [22, size, true], [26, label.length],
        ]), label, file.bytes);
        directory.push(header(46, [
            [0, 0x02014b50, true], [4, 20], [6, 20], [8, 0x0800], [14, 33],
            [16, crc, true], [20, size, true], [24, size, true], [28, label.length], [42, offset, true],
        ]), label);
        offset += 30 + label.length + size;
        directorySize += 46 + label.length;
    }
    if (offset + directorySize + 22 > 0xffffffff) throw new Error('ZIP 太大，请分批下载');
    const end = header(22, [
        [0, 0x06054b50, true], [8, names.size], [10, names.size], [12, directorySize, true], [16, offset, true],
    ]);
    return new Blob([...body, ...directory, end], {type: 'application/zip'});
}
