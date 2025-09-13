// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/ITroveManager.sol";
import "../Interfaces/IRewards.sol";
import "../Interfaces/IFeeRouter.sol";
import "../Interfaces/IGlobalFeeRouter.sol";
import "../Interfaces/ILiquidations.sol";
import "../Interfaces/IAggregator.sol";
import "../Interfaces/IStabilityPool.sol";
import "../Interfaces/ICollSurplusPool.sol";
import "../Interfaces/ILUSDToken.sol";
import "../Interfaces/ISortedTroves.sol";
import "../Interfaces/ILQTYToken.sol";
import "../Interfaces/ILQTYStaking.sol";
import "../Interfaces/IRelayer.sol";
import "./LiquityBase.sol";
import "./Ownable.sol";
import "./CheckContract.sol";
// import "./Dependencies/console.sol";

/*
library Str {
    function utoa(uint256 v) internal pure returns (string memory s) {
        if (v == 0) return "0";
        uint256 j=v; uint256 len;
        while (j != 0) { len++; j/=10; }
        bytes memory b = new bytes(len);
        j = v;
        while (v != 0) { b[--len] = bytes1(uint8(48 + v % 10)); v/=10; }
        return string(b);
    }
    function addr(address a) internal pure returns (string memory) {
        bytes32 b = bytes32(uint256(uint160(a)));
        bytes memory hexChars = "0123456789abcdef";
        bytes memory s = new bytes(2 + 40);
        s[0] = '0'; s[1] = 'x';
        for (uint i=0; i<20; i++) {
            s[2+i*2]   = hexChars[uint8(b[i+12] >> 4)];
            s[3+i*2]   = hexChars[uint8(b[i+12] & 0x0f)];
        }
        return string(s);
    }
}
*/

library ShutdownLib {

    struct CollateralShutdown {
        uint256 shutdownTime;
        uint256 par;
        uint256 rate;
        bool oracleFailure;
    }


}