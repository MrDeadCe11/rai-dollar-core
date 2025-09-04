// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/IAggregator.sol";
import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IStabilityPool.sol";
import "./Interfaces/ICollSurplusPool.sol";
import "./Interfaces/ILUSDToken.sol";
import "./Interfaces/ISortedTroves.sol";
import "./Interfaces/ILQTYToken.sol";
import "./Interfaces/ILQTYStaking.sol";
import "./Interfaces/IRelayer.sol";
import "./Dependencies/LiquityBase.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
import "./Dependencies/console.sol";

contract Aggregator is LiquityBase, Ownable, CheckContract, IAggregator {
    string constant public NAME = "Aggregator";

    // --- Connected contract declarations ---

    //address public troveManagerAddress;
    ITroveManager public troveManager;

    ILUSDToken public override lusdToken;

    // --- Data structures ---

    uint constant public SECONDS_IN_ONE_MINUTE = 60;
    /*
     * Half-life of 12h. 12h = 720 min
     * (1/2) = d^720 => d = (1/2)^(1/720)
     */
    uint constant public MINUTE_DECAY_FACTOR = 999037758833783000;
    uint constant public REDEMPTION_FEE_FLOOR = DECIMAL_PRECISION / 1000 * 5; // 0.5%

    // shutdown discount parameters
    uint256 constant public DECIMAL_PRECISION = 1e18;
    uint256 constant public FOUR_HOURS = 14400; // 14400 seconds
    uint256 constant public BASE_DISCOUNT = 2e16; // 2%
    uint256 constant public MAX_DISCOUNT = 5e17; // 50%
    uint256 constant public MULTIPLIER = 125e16; // 1.25 * 1e18
    
    struct CollateralShutdown {
        address shutdownTime;
        uint256 par;
        bool oracleFailure;
    }

    // troveManager address => collateralShutdown
    mapping (address => CollateralShutdown) public collateralShutdown;

    /*
    * BETA: 18 digit decimal. Parameter by which to divide the redeemed fraction, in order to calc the new base rate from a redemption.
    * Corresponds to (1 / ALPHA) in the white paper.
    */
    uint constant public BETA = 2;

    uint public override baseRate;

    // The timestamp of the latest fee operation (redemption only)
    uint public override lastFeeOperationTime;

    // per troveManager rate multiplier
    mapping (address => uint256) public rateMultiplier;
    // per troveManager minimum red fees
    mapping (address => uint256) public minRedemptionFee;
    // per troveManager debt target,  % of total debt
    mapping (address => uint256) public debtTarget;

    address[1] public troveManagers;

    // --- Events ---
    event BaseRateUpdated(uint _baseRate);
    event LastFeeOpTimeUpdated(uint _lastFeeOpTime);

    // --- Dependency setter ---

    function setAddresses(
        address _troveManagerAddress,
        address _lusdTokenAddress
    )
        external
        override
        onlyOwner
    {
        checkContract(_troveManagerAddress);
        checkContract(_lusdTokenAddress);

        //troveManagerAddress = _troveManagerAddress;
        troveManager = ITroveManager(_troveManagerAddress);
        lusdToken = ILUSDToken(_lusdTokenAddress);

        troveManagers[0] = address(troveManager);

        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit LUSDTokenAddressChanged(_lusdTokenAddress);

        _renounceOwnership();
    }

    // --- Redemption fee functions ---

    /*
    * This function has two impacts on the baseRate state variable:
    * 1) decays the baseRate based on time passed since last redemption or LUSD borrowing operation.
    * then,
    * 2) increases the baseRate based on the amount redeemed, as a proportion of total supply
    */
    function updateBaseRateFromRedemption(uint _LUSDAmount, uint _totalLUSDSupply) external override returns (uint) {
        _requireCallerIsTroveManager();
        uint decayedBaseRate = _calcDecayedBaseRate();

        uint newBaseRate = calcNewBaseRate(_LUSDAmount, decayedBaseRate,_totalLUSDSupply);

        assert(newBaseRate > 0); // Base rate is always non-zero after redemption

        // Update the baseRate state variable
        baseRate = newBaseRate;
        emit BaseRateUpdated(newBaseRate);
        
        _updateLastFeeOpTime();

        return newBaseRate;
    }

    function calcNewBaseRate(uint _LUSDAmount, uint _baseRate, uint _totalLUSDSupply) public view override returns (uint) {
        uint redeemedLUSDFraction = _LUSDAmount.mul(DECIMAL_PRECISION).div(_totalLUSDSupply);

        uint256 newBaseRate = _baseRate.add(redeemedLUSDFraction.div(BETA));

        newBaseRate = LiquityMath._min(newBaseRate, DECIMAL_PRECISION); // cap baseRate at a maximum of 100%

        return newBaseRate;
    }

    function calcRateForRedemption(uint _LUSDAmount, uint _totalLUSDSupply) public view override returns (uint) {
        uint256 newBaseRate = calcNewBaseRate(_LUSDAmount, baseRate, _totalLUSDSupply);
        return _calcRedemptionRate(newBaseRate);
    }

    function calcRedemptionRateForShutdown(uint _LUSDAmount, uint _totalLUSDSupply) public view override returns (uint) {
        uint256 newBaseRate = calcNewBaseRate(_LUSDAmount, baseRate, _totalLUSDSupply);
        uint256 discount = _calcDiscount(newBaseRate);
        uint256 redemptionRate = _calcRedemptionRate(newBaseRate);

        return redemptionRate.mul(DECIMAL_PRECISION.sub(discount)).div(DECIMAL_PRECISION);
    }

    function getRedemptionRate() public view override returns (uint) {
        return _calcRedemptionRate(baseRate);
    }

    function getRedemptionRateWithDecay() public view override returns (uint) {
        return _calcRedemptionRate(_calcDecayedBaseRate());
    }

    function getRedemptionFee(uint _ETHDrawn) public view override returns (uint) {
        return calcRedemptionFee(getRedemptionRate(), _ETHDrawn);
    }

    function getRedemptionFeeWithDecay(uint _ETHDrawn) external view override returns (uint) {
        return calcRedemptionFee(getRedemptionRateWithDecay(), _ETHDrawn);
    }

    function calcRedemptionFee(uint _redemptionRate, uint _ETHDrawn) public view override returns (uint) {
        if (_ETHDrawn == 0) return 0;
        uint redemptionFee = _redemptionRate.mul(_ETHDrawn).div(DECIMAL_PRECISION);
        require(redemptionFee < _ETHDrawn, "TroveManager: Fee would eat up all returned collateral");
        return redemptionFee;
    }

    function shutdownCollateral(uint256 _par, bool _oracleFailure) external override {
        _requireCallerIsTroveManager();
        collateralShutdown[address(troveManager)] = CollateralShutdown(block.timestamp, par, _oracleFailure);
    }

    // --- Internal fee functions ---

    function _calcRedemptionRate(uint _baseRate) internal pure returns (uint) {
        return LiquityMath._min(
            REDEMPTION_FEE_FLOOR.add(_baseRate),
            DECIMAL_PRECISION // cap at a maximum of 100%
        );
    }

    function _calcDiscount(uint _baseRate) internal view returns (uint) {
        uint timePassed = block.timestamp.sub(collateralShutdown[address(troveManager)].shutdownTime);
        
        uint256 periods = timePassed.div(FOUR_HOURS);
        
        // Calculate 1.25^periods using existing _rpower function
        uint256 multiplierPowered = LiquityMath._rpower(MULTIPLIER, periods, DECIMAL_PRECISION);
        
        // Calculate discount = 2% × 1.25^periods
        uint256 discount = BASE_DISCOUNT.mul(multiplierPowered).div(DECIMAL_PRECISION);
        
        // Apply 50% cap
        return discount > MAX_DISCOUNT ? MAX_DISCOUNT : discount;
    }

    // Update the last fee operation time only if time passed >= decay interval. This prevents base rate griefing.
    function _updateLastFeeOpTime() internal {
        uint timePassed = block.timestamp.sub(lastFeeOperationTime);

        if (timePassed >= SECONDS_IN_ONE_MINUTE) {
            lastFeeOperationTime = block.timestamp;
            emit LastFeeOpTimeUpdated(block.timestamp);
        }
    }

    function _calcDecayedBaseRate() internal view returns (uint) {
        uint minutesPassed = _minutesPassedSinceLastFeeOp();
        uint decayFactor = LiquityMath._decPow(MINUTE_DECAY_FACTOR, minutesPassed);

        return baseRate.mul(decayFactor).div(DECIMAL_PRECISION);
    }

    function _minutesPassedSinceLastFeeOp() internal view returns (uint) {
        return (block.timestamp.sub(lastFeeOperationTime)).div(SECONDS_IN_ONE_MINUTE);
    }
    
    // --- rate multiplier functions ---
    function relativeError(uint _measured,  uint _target) internal pure returns (uint) {
        return (_measured.sub(_target)).mul(DECIMAL_PRECISION).div(_target);
    }

    function troveManagerLength() external view returns (uint) {
        return troveManagers.length;
    }

    // --- 'require' wrapper functions ---

    function _requireCallerIsTroveManager() internal view {
        //require(msg.sender == troveManagerAddress, "Aggregator: Caller is not TroveManager contract");
        require(msg.sender == address(troveManager), "Aggregator: Caller is not TroveManager contract");
    }

    function getEntireSystemDebt() external view returns (uint totalDebt) {
        uint len = troveManagers.length;
        for (uint i = 0; i < len; i++) {
            totalDebt += ITroveManager(troveManagers[i]).getEntireSystemDebt();
        }

    }

}
