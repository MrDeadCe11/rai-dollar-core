// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "./v0.8.24/Interfaces/IParControl.sol";
import "./v0.8.24/Interfaces/IRateControl.sol";
import "./v0.8.24/Interfaces/IMarketOracle.sol";
import "./v0.8.24/Interfaces/ITroveManager.sol";
import "./v0.8.24/Interfaces/IBorrowerOperations.sol";
import "./v0.8.24/Dependencies/Ownable.sol";
import "./v0.8.24/Dependencies/CheckContract.sol";

contract Relayer is Ownable, CheckContract {
    uint256 constant DECIMAL_PRECISION = 1e18;
    int256 constant DECIMAL_PRECISION_I = 1e18;
    uint256 constant RATE_PRECISION = 1e27;
    int256 constant RATE_PRECISION_I = 1e27;
    uint256 public constant MAX_PAR_STALENESS = 600;
    uint256 public constant MAX_RATE_STALENESS = 300;

    uint256 constant PAR_EPSILON_1 = 1 * 10**15; // $0.001
    uint256 constant PAR_EPSILON_2 = 3 * 10**15; // $0.003

    uint256 constant RATE_EPSILON_1 = 1 * 10**24; // $0.001
    uint256 constant RATE_EPSILON_2 = 3 * 10**24; // $0.003
   
    uint256 public lastParUpdateTime;
    uint256 public lastRateUpdateTime;
    uint256 public par = DECIMAL_PRECISION;
    uint256 public rate = RATE_PRECISION;

    event ParControlAddressChanged(address newAddress);
    event RateControlAddressChanged(address newAddress);
    event MarketOracleAddressChanged(address newAddress);
    event TroveManagerAddressChanged(address newAddress);
    event BorrowerOperationsAddressChanged(address newAddress);
    event ParUpdated(int256 par, int256 pOutput, int256 iOutput, int256 error);
    event RateUpdated(int256 rate, int256 pOutput, int256 iOutput, int256 error);

    IParControl public parControl;
    IRateControl public rateControl;
    IMarketOracle public marketOracle;
    ITroveManager public troveManager;
    IBorrowerOperations public borrowerOperations;

    function setAddresses(
        address parControlAddress,
        address rateControlAddress,
        address marketOracleAddress,
        address troveManagerAddress,
        address borrowerOperationsAddress
    ) external onlyOwner {
        checkContract(parControlAddress);
        checkContract(rateControlAddress);
        checkContract(marketOracleAddress);
        checkContract(troveManagerAddress);
        checkContract(borrowerOperationsAddress);

        parControl = IParControl(parControlAddress);
        rateControl = IRateControl(rateControlAddress);
        marketOracle = IMarketOracle(marketOracleAddress);
        troveManager = ITroveManager(troveManagerAddress);
        borrowerOperations = IBorrowerOperations(borrowerOperationsAddress);

        emit ParControlAddressChanged(parControlAddress);
        emit RateControlAddressChanged(rateControlAddress);
        emit MarketOracleAddressChanged(marketOracleAddress);
        emit TroveManagerAddressChanged(troveManagerAddress);
        emit BorrowerOperationsAddressChanged(borrowerOperationsAddress);

        _renounceOwnership();
    }

    function _rateControlError(uint256 market) internal pure returns (int256) {
        return RATE_PRECISION_I - int256(market) * 10**9;
    }

    function _parControlError(uint256 market) internal pure returns (int256) {
        return DECIMAL_PRECISION_I - int256(market);
    }

    /*
    * @notice Sets error to 0 inside a deadband and scales it up towards the outerband
    * @param error The system error EIGHTEEN_DECIMAL_NUMBER
    * @param eps_1 lower band EIGHTEEN_DECIMAL_NUMBER
    * @param eps_2 outer band EIGHTEEN_DECIMAL_NUMBER
    */
    function _rampErrorDec(int256 error, uint256 eps_1, uint256 eps_2) internal pure returns (int256 scaledError) {
        int256 absError = error >= 0 ? error : -error;

        if (absError <= int256(eps_1)) {
            return 0;
        }

        if (absError >= int256(eps_2)) {
            return error;
        }

        // Ramp = (|e| - ε1) / (ε2 - ε1)
        uint256 rampNumerator = uint256(absError - int256(eps_1));
        uint256 rampDenominator = eps_2 - eps_1;
        uint256 rampFactor = (rampNumerator * DECIMAL_PRECISION) / rampDenominator;

        scaledError = (error * int256(rampFactor)) / DECIMAL_PRECISION_I;
    }

    /*
    * @notice Sets error to 0 inside a deadband and scales it up towards the outerband
    * @param error The system error TWENTY_SEVEN_DECIMAL_NUMBER
    * @param eps_1 lower band TWENTY_SEVEN_DECIMAL_NUMBER
    * @param eps_2 outer band TWENTY_SEVEN_DECIMAL_NUMBER
    */
    function _rampErrorRay(int256 error, uint256 eps_1, uint256 eps_2) internal pure returns (int256 scaledError) {
        int256 absError = error >= 0 ? error : -error;

        if (absError <= int256(eps_1)) {
            return 0;
        }

        if (absError >= int256(eps_2)) {
            return error;
        }

        // Ramp = (|e| - ε1) / (ε2 - ε1)
        uint256 rampNumerator = uint256(absError - int256(eps_1));
        uint256 rampDenominator = eps_2 - eps_1;
        uint256 rampFactor = (rampNumerator * RATE_PRECISION) / rampDenominator;

        scaledError = (error * int256(rampFactor)) / RATE_PRECISION_I;
    }

    function rateIsStale() public view returns (bool) {
        return block.timestamp - lastRateUpdateTime > MAX_RATE_STALENESS;
    }

    function parIsStale() public view returns (bool) {
        return block.timestamp - lastParUpdateTime > MAX_PAR_STALENESS;
    }

    // Permissionless getters for par and rate that update if they are stale
    function getPar() public returns (uint256) {
        if (parIsStale()) {
            uint256 marketPrice = marketOracle.price();
            return _updatePar(marketPrice);
        }

        return par;
    }

    function getRate() public returns (uint256) {
        if (rateIsStale()) {
            uint256 marketPrice = marketOracle.price();
            return _updateRate(marketPrice);
        }

        return rate;
    }

    function getRateAndPar() external returns (uint256, uint256) {
        uint256 rateVal = getRate();
        uint256 parVal = getPar();
        return (rateVal, parVal);
    }

    // Permissionless updates of rate and par
    function updatePar() external returns (uint256) {
        uint256 marketPrice = marketOracle.price();
        return _updatePar(marketPrice);
    }

    function _updatePar(uint256 marketPrice) internal returns (uint256) {
        int256 error = _parControlError(marketPrice);
        int256 rampedError =  _rampErrorDec(error, PAR_EPSILON_1, PAR_EPSILON_2);

        (int256 newPar, int256 pOutput, int256 iOutput) = parControl.update(rampedError);

        emit ParUpdated(newPar, pOutput, iOutput, rampedError);

        lastParUpdateTime = block.timestamp;

        par = uint256(newPar);

        return uint256(newPar);
    }

    function updateRate() external returns (uint256) {
        uint256 marketPrice = marketOracle.price();
        return _updateRate(marketPrice);
    }

    function _updateRate(uint256 market) internal returns (uint256) {
        int256 error = _rateControlError(market);
        int256 rampedError =  _rampErrorRay(error, RATE_EPSILON_1, RATE_EPSILON_2);

        (int256 newRate, int256 pOutput, int256 iOutput) = rateControl.update(rampedError);
        emit RateUpdated(newRate, pOutput, iOutput, rampedError);

        lastRateUpdateTime = block.timestamp;

        // RateControl output is a "delta rate" so need to add 1 to get per-sec rate
        rate = RATE_PRECISION + uint256(newRate);

        return rate;
    }

    function updateRateAndPar() external returns (uint256, uint256) {
        uint256 marketPrice = marketOracle.price();
        return (_updateRate(marketPrice),  _updatePar(marketPrice));
    }

    // Updates rate and par with market price, from oracle only
    function updateRateWithMarket(uint256 marketPrice) external returns (uint256) {
        _requireCallerIsMarketOracle();
        return _updateRate(marketPrice);
    }

    function updateParWithMarket(uint256 marketPrice) external returns (uint256) {
        _requireCallerIsMarketOracle();
        return _updatePar(marketPrice);
    }

    function updateRateAndParWithMarket(uint256 rateMarketPrice, uint256 parMarketPrice) external returns (uint256, uint256) {
        _requireCallerIsMarketOracle();
        uint newRate = _updateRate(rateMarketPrice);
        uint newPar = _updatePar(parMarketPrice);
        return (newRate, newPar);
    }

    // Views
    function nextPar() public view returns (uint256 newPar) {
        uint256 marketPrice = marketOracle.price();
        int256 error = _parControlError(marketPrice);
        int256 rampedError =  _rampErrorDec(error, PAR_EPSILON_1, PAR_EPSILON_2);

        (int256 newPar, int256 pOutput, int256 iOutput) = parControl.getNextPiOutput(rampedError);
    }

    function nextRate() public view returns (uint256 newRate) {
        uint256 marketPrice = marketOracle.price();
        int256 error = _parControlError(marketPrice);
        int256 rampedError =  _rampErrorDec(error, RATE_EPSILON_1, RATE_EPSILON_2);

        (int256 newRate, int256 pOutput, int256 iOutput) = rateControl.getNextPiOutput(rampedError);
    }

    function nextRateAndPar() public view returns (uint newRate, uint newPar) {
        return (nextRate(), nextPar());
    }

    function _requireCallerIsTroveManagerOrBO() internal view {
        require(msg.sender == address(troveManager) ||
                msg.sender == address(borrowerOperations),
        "Relayer: Caller is not TroveManager or BorrowerOperations contract");
    }
    function _requireCallerIsMarketOracle() internal view {
        require(msg.sender == address(marketOracle), "Relayer: Caller is not the MarketOracle contract");
    }
}
