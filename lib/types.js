"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CollateralTokenActive = exports.EventStatus = exports.SystemMode = void 0;
var SystemMode;
(function (SystemMode) {
    SystemMode[SystemMode["Recovery"] = 0] = "Recovery";
    SystemMode[SystemMode["Normal"] = 1] = "Normal";
})(SystemMode = exports.SystemMode || (exports.SystemMode = {}));
var EventStatus;
(function (EventStatus) {
    EventStatus[EventStatus["Inactive"] = 0] = "Inactive";
    EventStatus[EventStatus["PendingCollection"] = 1] = "PendingCollection";
})(EventStatus = exports.EventStatus || (exports.EventStatus = {}));
var CollateralTokenActive;
(function (CollateralTokenActive) {
    CollateralTokenActive[CollateralTokenActive["SOL"] = 0] = "SOL";
    CollateralTokenActive[CollateralTokenActive["ETH"] = 1] = "ETH";
    CollateralTokenActive[CollateralTokenActive["BTC"] = 2] = "BTC";
    CollateralTokenActive[CollateralTokenActive["SRM"] = 3] = "SRM";
    CollateralTokenActive[CollateralTokenActive["RAY"] = 4] = "RAY";
    CollateralTokenActive[CollateralTokenActive["FTT"] = 5] = "FTT";
    CollateralTokenActive[CollateralTokenActive["MSOL"] = 6] = "MSOL";
})(CollateralTokenActive = exports.CollateralTokenActive || (exports.CollateralTokenActive = {}));
//# sourceMappingURL=types.js.map