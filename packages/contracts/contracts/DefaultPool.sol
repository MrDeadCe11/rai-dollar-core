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
    address public liquidationsAddress;
    address public rewardsAddress;
    address public troveManagerAddress;
    address public activePoolAddress;
    address public activeShieldedPoolAddress;
    uint256 internal CT;  // deposited Collateral Token tracker
    uint256 internal LUSDDebt;  // debt

    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event DefaultPoolLUSDDebtUpdated(uint _LUSDDebt);
    event DefaultPoolCollateralBalanceUpdated(uint _COLLATERAL);

    // --- Dependency setters ---

    function setAddresses(
        address _liquidationsAddress,
        address _rewardsAddress,
        address _troveManagerAddress,
        address _activePoolAddress,
        address _activeShieldedPoolAddress,
        address _collateralTokenAddress
    )
        external
        onlyOwner
    {
        checkContract(_liquidationsAddress);
        checkContract(_rewardsAddress);
        checkContract(_troveManagerAddress);
        checkContract(_activePoolAddress);
        checkContract(_activeShieldedPoolAddress);
        checkContract(_collateralTokenAddress);

        liquidationsAddress = _liquidationsAddress;
        rewardsAddress = _rewardsAddress;
        troveManagerAddress = _troveManagerAddress;
        activePoolAddress = _activePoolAddress;
        activeShieldedPoolAddress = _activeShieldedPoolAddress;
        collateralToken = IERC20(_collateralTokenAddress);

        emit LiquidationsAddressChanged(_liquidationsAddress);
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
        return CT;
    }

    function getLUSDDebt() external view override returns (uint) {
        return LUSDDebt;
    }

    // --- Pool functionality ---

    function sendCollateralToActivePool(IActivePool _activePool, uint _amount) external override {
        _requireCallerIsRewards();
        CT = CT.sub(_amount);

        emit DefaultPoolCollateralBalanceUpdated(CT);
        emit CollateralSent(address(_activePool), _amount);
        
        // transfer collateral to active pool
        collateralToken.transfer(address(_activePool), _amount);
        // process collateral increase
        _activePool.processCollateralIncrease(_amount);
    }

    function addCollateral(address _account, uint _amount) external override {
        _requireCallerIsTroveMorActivePool();
        CT = CT.add(_amount);
        emit DefaultPoolCollateralBalanceUpdated(CT);
        collateralToken.transferFrom(_account, address(this), _amount);
    }

    function processCollateralIncrease(uint _amount) external override {
        _requireCallerIsTroveMorActivePool();
        CT = CT.add(_amount);
        emit DefaultPoolCollateralBalanceUpdated(CT);
    }

    function increaseLUSDDebt(uint _amount) external override {
        _requireCallerIsRewards();
        LUSDDebt = LUSDDebt.add(_amount);
        emit DefaultPoolLUSDDebtUpdated(LUSDDebt);
    }

    function decreaseLUSDDebt(uint _amount) external override {
        _requireCallerIsRewards();
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

    function _requireCallerIsRewards() internal view {
        require(msg.sender == rewardsAddress, "DefaultPool: Caller is not Rewards");
    }

    function _requireCallerIsTMorLiquidations() internal view {
        require(msg.sender == troveManagerAddress || 
               msg.sender == liquidationsAddress,
                "DefaultPool: Caller is not TM or Liquidations");
    }

    function _requireCallerIsTroveMorActivePool() internal view {
        require(
            msg.sender == troveManagerAddress ||
            msg.sender == activePoolAddress ||
            msg.sender == activeShieldedPoolAddress,
            "DefaultPool: Caller is neither TM nor ActivePool");
    }
}
