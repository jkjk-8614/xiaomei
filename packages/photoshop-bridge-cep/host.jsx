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

// Export the active Photoshop layer without changing the user's document.
// The CEP panel reads the temporary PNG and sends it to the canvas inbox.
function exportActiveLayerToPng(filePath) {
    var source = null;
    var temporary = null;
    try {
        if (!app.documents.length) {
            return "ERROR:请先在 Photoshop 打开一个文档。";
        }
        source = app.activeDocument;
        if (!source.activeLayer) {
            return "ERROR:请先在图层面板选中一个图层。";
        }
        var layerName = String(source.activeLayer.name || "Photoshop 图层").replace(/[\\/:*?\"<>|]/g, "_");
        var documentName = String(source.name || "Photoshop 文档").replace(/[\\/:*?\"<>|]/g, "_");
        temporary = app.documents.add(source.width, source.height, source.resolution, "小美图层导出", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
        source.activeLayer.duplicate(temporary, ElementPlacement.PLACEATBEGINNING);
        app.activeDocument = temporary;
        var file = new File(String(filePath || ""));
        var options = new PNGSaveOptions();
        temporary.saveAs(file, options, true, Extension.LOWERCASE);
        temporary.close(SaveOptions.DONOTSAVECHANGES);
        temporary = null;
        app.activeDocument = source;
        return "OK|" + layerName + "|" + documentName;
    } catch (error) {
        try { if (temporary) temporary.close(SaveOptions.DONOTSAVECHANGES); } catch (_) {}
        try { if (source) app.activeDocument = source; } catch (_) {}
        return "ERROR:" + error;
    }
}
