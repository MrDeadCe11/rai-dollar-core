// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library EmaLib {
    uint256 internal constant SCALE = 1e27;
    uint256 internal constant MAX_DECAY_IDX = 24;

    struct State {
        uint256 ema;
        uint256 lastUpdate; // timestamp
        uint256 halflife; // seconds
    }

    function init(State storage s, uint256 initialEma, uint256 halflife) internal {
        require(halflife > 0, "Ema: halflife=0");
        s.ema = initialEma;
        s.lastUpdate = block.timestamp;
        s.halflife = halflife;
    }

    function _decayByIdx(State storage s, uint256 idx) internal pure returns (uint256) {
        if (idx ==  0) return 1000000000000000000000000000;
        if (idx ==  1) return 971531941153605868743289415;
        if (idx ==  2) return 943874312681693496641913156;
        if (idx ==  3) return 917004043204671231743541594;
        if (idx ==  4) return 890898718140339304740226205;
        if (idx ==  5) return 865536561006143026695092218;
        if (idx ==  6) return 840896415253714543031125476;
        if (idx ==  7) return 816957726620549921839122025;
        if (idx ==  8) return 793700525984099737375852819;
        if (idx ==  9) return 771105412703970411806145931;
        if (idx == 10) return 749153538438340749399640366;
        if (idx == 11) return 727826591421093677177557780;
        if (idx == 12) return 707106781186547524400844362;
        if (idx == 13) return 686976823729044550888327873;
        if (idx == 14) return 667419927085017182415415940;
        if (idx == 15) return 648419777325504832966877058;
        if (idx == 16) return 629960524947436582383605303;
        if (idx == 17) return 612026771652327619566080108;
        if (idx == 18) return 594603557501360533358749985;
        if (idx == 19) return 577676348436136505122668549;
        if (idx == 20) return 561231024154686490716766524;
        if (idx == 21) return 545253866332628829603505327;
        if (idx == 22) return 529731547179647632280912647;
        if (idx == 23) return 514651118321746014391185900;
        // >= 24
        return 500000000000000000000000000;
    }

    function _decayFactor(State storage s, uint256 dt) internal view returns (uint256) {
        uint256 idx = (dt * MAX_DECAY_IDX) / s.halflife;
        if (idx > MAX_DECAY_IDX) idx = MAX_DECAY_IDX;
        return _decayByIdx(s, idx);
    }

    function preview(State storage s, uint256 current, uint256 nowTs)
        internal
        view
        returns (uint256 next, uint256 decay)
    {
        uint256 dt = nowTs - s.lastUpdate;
        if (dt == 0) return (s.ema, SCALE);
        decay = _decayFactor(s, dt);
        next  = ((SCALE - decay) * current + decay * s.ema) / SCALE;
    }

    /// Updates s.ema and (only if decayed) s.lastUpdate
    function update(State storage s, uint256 current)
        internal
        returns (uint256 newEma, uint256 decay)
    {
        (newEma, decay) = preview(s, current, block.timestamp);
        if (decay < SCALE) s.lastUpdate = block.timestamp;
        s.ema = newEma;
    }
}
