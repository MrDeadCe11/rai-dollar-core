// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import './Interfaces/IDefaultPool.sol';
import "./Dependencies/SafeMath.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
import "./Dependencies/console.sol";
import "./Dependencies/IERC20.sol";
import "./Interfaces/IActivePool.sol";
/*
 * The Default Pool holds the ETH and LUSD debt (but not LUSD tokens) from liquidations that have been redistributed
 * to active troves but not yet "applied", i.e. not yet recorded on a recipient active trove's struct.
 *
 * When a trove makes an operation that applies its pending ETH and LUSD debt, its pending ETH and LUSD debt is moved
 * from the Default Pool to the Active Pool.
 */
contract DefaultPool is Ownable, CheckContract, IDefaultPool {
    using SafeMath for uint256;

    string constant public NAME = "DefaultPool";

    IERC20 public collateralToken;
    address public troveManagerAddress;
    address public activePoolAddress;
    uint256 internal collateral;  // deposited collateral tracker
    uint256 internal LUSDDebt;  // debt

    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event DefaultPoolLUSDDebtUpdated(uint _LUSDDebt);
    event DefaultPoolCollateralBalanceUpdated(uint _COLLATERAL);

    // --- Dependency setters ---

    function setAddresses(
        address _collateralTokenAddress,
        address _troveManagerAddress,
        address _activePoolAddress
    )
        external
        onlyOwner
    {
        checkContract(_collateralTokenAddress);
        checkContract(_troveManagerAddress);
        checkContract(_activePoolAddress);

        collateralToken = IERC20(_collateralTokenAddress);
        troveManagerAddress = _troveManagerAddress;
        activePoolAddress = _activePoolAddress;

        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit ActivePoolAddressChanged(_activePoolAddress);

        _renounceOwnership();
    }

    // --- Getters for public variables. Required by IPool interface ---

    /*
    * Returns the collateral state variable.
    *
    * Not necessarily equal to the the contract's raw collateral balance - collateral can be forcibly sent to contracts.
    */
    function getCollateral() external view override returns (uint) {
        return collateral;
    }

    function getLUSDDebt() external view override returns (uint) {
        return LUSDDebt;
    }

    // --- Pool functionality ---

    function sendCollateralToActivePool(uint _amount) external override {
        _requireCallerIsTroveManager();
        IActivePool activePool = IActivePool(activePoolAddress);
        collateral = collateral.sub(_amount);
        emit DefaultPoolCollateralBalanceUpdated(collateral);
        emit CollateralSent(activePoolAddress, _amount);
        
        // transfer collateral to active pool
        collateralToken.transfer(activePoolAddress, _amount);
        // process collateral increase
        activePool.processCollateralIncrease(_amount);
    }

    function addCollateral(address _account, uint _amount) external override {
        _requireCallerIsTroveMorActivePool();
        collateral = collateral.add(_amount);
        emit DefaultPoolCollateralBalanceUpdated(collateral);
        collateralToken.transferFrom(_account, address(this), _amount);
    }

    function processCollateralIncrease(uint _amount) external override {
        _requireCallerIsTroveMorActivePool();
        collateral = collateral.add(_amount);
        emit DefaultPoolCollateralBalanceUpdated(collateral);
    }

    function increaseLUSDDebt(uint _amount) external override {
        _requireCallerIsTroveManager();
        LUSDDebt = LUSDDebt.add(_amount);
        emit DefaultPoolLUSDDebtUpdated(LUSDDebt);
    }

    function decreaseLUSDDebt(uint _amount) external override {
        _requireCallerIsTroveManager();
        LUSDDebt = LUSDDebt.sub(_amount);
        emit DefaultPoolLUSDDebtUpdated(LUSDDebt);
    }

    // --- 'require' functions ---

    function _requireCallerIsActivePool() internal view {
        require(msg.sender == activePoolAddress, "DefaultPool: Caller is not the ActivePool");
    }

    function _requireCallerIsTroveManager() internal view {
        require(msg.sender == troveManagerAddress, "DefaultPool: Caller is not the TroveManager");
    }

    function _requireCallerIsTroveMorActivePool() internal view {
        require(
            msg.sender == troveManagerAddress ||
            msg.sender == activePoolAddress,
            "DefaultPool: Caller is neither BorrowerOperations nor TroveManager nor StabilityPool nor Default Pool");
    }

    // --- Fallback function ---

    // receive() external payable {
    //     _requireCallerIsActivePool();
    //     ETH = ETH.add(msg.value);
    //     emit DefaultPoolETHBalanceUpdated(ETH);
    // }
}
