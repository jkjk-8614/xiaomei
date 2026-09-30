/* Photoshop ExtendScript host for the direct CEP bridge. */

function importInfiniteCanvasImage(filePath, layerName, openMode) {
    try {
        var file = new File(String(filePath || ""));
        if (!file.exists) {
            return "ERROR:图片文件不存在：" + file.fsName;
        }
        if (openMode === "document" || !app.documents.length) {
            app.open(file);
            return "opened-document";
        }

        var placeEvent = charIDToTypeID("Plc ");
        var descriptor = new ActionDescriptor();
        descriptor.putPath(charIDToTypeID("null"), file);
        descriptor.putEnumerated(
            charIDToTypeID("FTcs"),
            charIDToTypeID("QCSt"),
            charIDToTypeID("Qcsa")
        );
        var offset = new ActionDescriptor();
        offset.putUnitDouble(charIDToTypeID("Hrzn"), charIDToTypeID("#Pxl"), 0.0);
        offset.putUnitDouble(charIDToTypeID("Vrtc"), charIDToTypeID("#Pxl"), 0.0);
        descriptor.putObject(charIDToTypeID("Ofst"), charIDToTypeID("Ofst"), offset);
        executeAction(placeEvent, descriptor, DialogModes.NO);

        if (layerName && app.activeDocument && app.activeDocument.activeLayer) {
            app.activeDocument.activeLayer.name = String(layerName);
        }
        return "placed-layer";
    } catch (error) {
        return "ERROR:" + error;
    }
}
