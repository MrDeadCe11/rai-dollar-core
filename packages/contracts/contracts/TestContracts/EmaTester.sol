// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../EmaLib.sol";

contract EmaTester {
    using EmaLib for EmaLib.State;
    EmaLib.State internal s;

    function init(uint256 _initialEma, uint256 _halflife) external {
        s.init(_initialEma, _halflife);
    }

    function preview(uint256 _current, uint256 _nowTs) external view returns (uint256 next, uint256 decay) {
        return s.preview(_current, _nowTs);
    }

    function previewCurrent(uint256 _current) external view returns (uint256 next, uint256 decay) {
        return s.preview(_current, block.timestamp);
    }

    function maxDecayIdx() external view returns (uint) { return EmaLib.MAX_DECAY_IDX; }

    function update(uint256 _current) external returns (uint256 next, uint256 decay) {
        return s.update(_current);
    }

    function get() external view returns (uint256 ema, uint256 lastUpdate, uint256 halflife) {
        return (s.ema, s.lastUpdate, s.halflife);
    }

    function ema() external view returns (uint256 ema) { return s.ema; }

    function lastUpdate() external view returns (uint256 ema) { return s.lastUpdate; }

    function halflife() external view returns (uint256) { return s.halflife; }

    function decayFactor(uint256 dt) external view returns (uint256) {
        return s._decayFactor(dt);
    }

    function decayByIdx(uint _idx) external view returns (uint256) {
        return s._decayByIdx(_idx);
    }
}
