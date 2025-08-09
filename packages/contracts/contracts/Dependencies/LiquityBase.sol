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

    uint constant public _100pct = 1000000000000000000; // 1e18 == 100%

    // Minimum collateral ratio for unshielded individual troves
    uint constant public MCR = 1100000000000000000; // 110%

    // Critical system collateral ratio. If the system's total collateral ratio (TCR) falls below the CCR, Recovery Mode is triggered.
    uint constant public CCR = 1500000000000000000; // 150%

    // Minimum collateral ratio for shieled troves
    // Shielded troves are still liquidated at MCR, but troves under HCR can be redeemed against
    uint constant public SHIELDED_MULTIPLIER = 17 * 10**17; //1.7
    uint constant public HCR = SHIELDED_MULTIPLIER * MCR / DECIMAL_PRECISION; // 1.7 * MCR

    // Amount of LUSD to be locked in gas pool on opening troves
    uint constant public LUSD_GAS_COMPENSATION = 200e18;

    // Minimum amount of net LUSD debt a trove must have
    uint constant public MIN_NET_DEBT = 1800e18;
    // uint constant public MIN_NET_DEBT = 0; 

    uint constant public PERCENT_DIVISOR = 200; // dividing by 200 yields 0.5%

    uint constant public BORROWING_FEE_FLOOR = DECIMAL_PRECISION / 1000 * 5; // 0.5%

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

    function getEntireSystemColl() public view returns (uint entireSystemColl) {
        uint activeColl = activePool.getCollateral();
        uint liquidatedColl = defaultPool.getCollateral();

        return activeColl.add(liquidatedColl);
    }

    function getEntireSystemDebt(uint accumulatedRate, uint accumulatedShieldRate) public view returns (uint entireSystemDebt) {
        //return _actualDebt(getEntireNormalizedSystemDebt(), accumulatedRate);
        return getEntireNormalizedSystemDebt().mul(accumulatedRate).div(RATE_PRECISION) +
               getEntireNormalizedShieldedSystemDebt().mul(accumulatedShieldRate).div(RATE_PRECISION);
    }

    function getEntireNormalizedSystemDebt() public view returns (uint entireSystemDebt) {
        uint activeDebt = activePool.getLUSDDebt();
        uint closedDebt = defaultPool.getLUSDDebt();

        return activeDebt.add(closedDebt);
    }

    function getEntireNormalizedShieldedSystemDebt() public view returns (uint entireShieldedSystemDebt) {
        entireShieldedSystemDebt = activePool.getLUSDShieldedDebt();
    }

    function updatePar() public returns (uint par) {
        return relayer.updatePar();
    }

    // Returns the normalized debt from actual debt
    function _normalizedDebt(uint256 debt, uint256 rate) internal pure returns (uint256 normDebt) {
        normDebt = debt.mul(RATE_PRECISION).div(rate);

        // Round up if rounding caused an underestimation
        /*
        if (normDebt.mul(rate).div(RATE_PRECISION) < debt) {
            normDebt += 1;
        }
        */
    }

    // Returns the actual debt from normalized debt
    function _actualDebt(uint256 normalizedDebt, uint256 rate) internal pure returns (uint256 actualDebt) {
        actualDebt = normalizedDebt.mul(rate).div(RATE_PRECISION);

        // Round up if rounding caused an underestimation
        /*
        if (actualDebt.mul(RATE_PRECISION).div(rate) < normalizedDebt) {
            actualDebt += 1;
        }
        */

    }

    /*
    // Returns the actual debt from normalized debt
    function _actualDebt(uint256 normalizedDebt, uint256 rate) internal pure returns (uint256) {
        return normalizedDebt.mul(rate).div(RATE_PRECISION);
    }
    */


    function _getTCR(uint _price, uint _accRate, uint _accShieldRate) internal view returns (uint TCR) {
        uint entireSystemColl = getEntireSystemColl();
        uint entireSystemDebt = getEntireSystemDebt(_accRate, _accShieldRate);
        uint par = relayer.par();

        TCR = LiquityMath._computeCR(entireSystemColl, entireSystemDebt, _price, par);

        return TCR;
    }

    function _checkRecoveryMode(uint _price, uint _accRate) internal view returns (bool) {
        uint TCR = _getTCR(_price, _accRate);

        return TCR < CCR;
    }

    function _requireUserAcceptsFee(uint _fee, uint _amount, uint _maxFeePercentage) internal pure {
        uint feePercentage = _fee.mul(DECIMAL_PRECISION).div(_amount);
        require(feePercentage <= _maxFeePercentage, "Fee exceeded provided maximum");
    }
}
