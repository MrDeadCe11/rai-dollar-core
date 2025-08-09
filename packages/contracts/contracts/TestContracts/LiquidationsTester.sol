// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Liquidations.sol";

contract LiquidationsTester is Liquidations {
    function setLiqPenalty(uint _liqPenalty) external {
        LIQUIDATION_PENALTY = _liqPenalty;
    }

    function setLiqPenaltyRedist(uint _liqPenaltyRedist) external {
        LIQUIDATION_PENALTY_REDIST = _liqPenaltyRedist;
    }

}
