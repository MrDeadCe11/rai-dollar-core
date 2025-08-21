// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./BaseMath.sol";
import "./LiquityMath.sol";
import "../Interfaces/IActivePool.sol";
import "../Interfaces/IDefaultPool.sol";
import "../Interfaces/IPriceFeed.sol";
import "../Interfaces/IRelayer.sol";
import "../Interfaces/ILiquityBase.sol";
import "../Dependencies/console.sol";

/* 
* Base contract for TroveManager, BorrowerOperations and StabilityPool. Contains global system constants and
* common functions. 
*/
contract LiquityBase is BaseMath, ILiquityBase {
    using SafeMath for uint;

    // Minimum collateral ratio for all individual troves, shielded and unshielded
    uint constant public MCR = 110 * 10**16; // 110%

    // Critical system collateral ratio.
    // If the system's total collateral ratio (TCR) falls below the CCR, some borrow ops are constrained
    uint constant public CCR = 150 * 10**16; // 150%

    // Shield collateral ratio
    // Shielded troves under HCR can be redeemed against but are still only liquidated when ICR < MCR
    uint constant public HCR = 130 * 10**16; //130%

    // Amount of LUSD to be locked in gas pool on opening troves
    uint constant public LUSD_GAS_COMPENSATION = 200e18;

    // Minimum amount of net LUSD debt a trove must have
    uint constant public MIN_NET_DEBT = 1800e18;

    uint constant public PERCENT_DIVISOR = 200; // dividing by 200 yields 0.5%

    IActivePool public override activePool;

    IActivePool public activeShieldedPool;

    IDefaultPool public defaultPool;

    IPriceFeed public override priceFeed;

    IRelayer public relayer; 

    // --- Gas compensation functions ---

    // Returns the composite debt (drawn debt + gas compensation) of a trove, for the purpose of ICR calculation
    function _getCompositeDebt(uint _debt) internal pure returns (uint) {
        return _debt.add(LUSD_GAS_COMPENSATION);
    }

    function _getNetDebt(uint _debt) internal pure returns (uint) {
        return _debt.sub(LUSD_GAS_COMPENSATION);
    }

    // Return the amount of ETH to be drawn from a trove's collateral and sent as gas compensation.
    function _getCollGasCompensation(uint _entireColl) internal pure returns (uint) {
        return _entireColl / PERCENT_DIVISOR;
    }

    function getEntireSystemColl() public view returns (uint) {
        return activePool.getCollateral().add(activeShieldedPool.getCollateral()).add(defaultPool.getCollateral());
    }

    function getEntireSystemDebt(uint accumulatedRate, uint accumulatedShieldRate) public view returns (uint) {
        uint baseDebt = activePool.getLUSDDebt().mul(accumulatedRate).div(RATE_PRECISION);
        uint shieldedDebt = activeShieldedPool.getLUSDDebt().mul(accumulatedShieldRate).div(RATE_PRECISION);
        return baseDebt + shieldedDebt + defaultPool.getLUSDDebt();
    }
    */

    // Returns the normalized debt from actual debt
    function _normalizedDebt(uint256 debt, uint256 rate) internal pure returns (uint256 normDebt) {
        normDebt = debt.mul(RATE_PRECISION).div(rate);

        // Round up if rounding caused an underestimation
        if (normDebt.mul(rate).div(RATE_PRECISION) < debt) {
            normDebt += 1;
        }
    }

    // Returns the actual debt from normalized debt
    function _actualDebt(uint256 normalizedDebt, uint256 rate) internal pure returns (uint256) {
        return normalizedDebt.mul(rate).div(RATE_PRECISION);

        // Round up if rounding caused an underestimation
        /*
        if (actualDebt.mul(RATE_PRECISION).div(rate) < normalizedDebt) {
            actualDebt += 1;
        }
        */

    }

    function _getTCR(uint _price, uint _accRate, uint _accShieldRate) internal view returns (uint) {
        return LiquityMath._computeCR(getEntireSystemColl(), getEntireSystemDebt(_accRate, _accShieldRate), _price, relayer.par());
    }

    function _checkRecoveryMode(uint _price, uint _accRate, uint _accShieldRate) internal view returns (bool) {
        return _getTCR(_price, _accRate, _accShieldRate) < CCR;
    }

    function _requireUserAcceptsFee(uint _fee, uint _amount, uint _maxFeePercentage) internal pure {
        uint feePercentage = _fee.mul(DECIMAL_PRECISION).div(_amount);
        require(feePercentage <= _maxFeePercentage, "Fee exceeded provided maximum");
    }
}
