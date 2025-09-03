// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../Control.sol";

contract ControlTester {
    using Control for Control.State;
    Control.State internal s;

    function init(int kp_, int ki_, int bias_, int lo_, int hi_) external {
        s.init(kp_, ki_, bias_, lo_, hi_);
    }
    function preview(int error, uint nowTs) external view returns (uint out, int integ, uint dt) {
        return s.preview(error, nowTs);
    }
    function update(int error) external returns (uint out) {
        return s.update(error);
    }
    function deadbandError(int error, int db) external pure returns (int) {
        return Control.deadbandError(error, db);
    }
    function getState() external view returns (int kp, int ki, int bias, int lo, int hi, int integ, uint lastTs) {
        return (s.kp, s.ki, s.bias, s.lowerBound, s.upperBound, s.integral, s.lastUpdate);
    }
}
