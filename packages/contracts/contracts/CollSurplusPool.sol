// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/ICollSurplusPool.sol";
import "./Dependencies/SafeMath.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
import "./Dependencies/console.sol";
import "./Dependencies/IERC20.sol";
import "./Interfaces/IBorrowerOperations.sol";

contract CollSurplusPool is Ownable, CheckContract, ICollSurplusPool {
    using SafeMath for uint256;

    string constant public NAME = "CollSurplusPool";

    address public borrowerOperationsAddress;
    address public liquidationsAddress;
    address public troveManagerAddress;
    address public activePoolAddress;
    address public activeShieldedPoolAddress;
    IERC20 public collateralToken;
    // deposited ether tracker
    uint256 internal CT;
    // Collateral surplus claimable by trove owners
    mapping (address => uint) internal balances;

    // --- Events ---

    event BorrowerOperationsAddressChanged(address _newBorrowerOperationsAddress);
    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolAddressChanged(address _newActivePoolAddress);

    event CollBalanceUpdated(address indexed _account, uint _newBalance);
    event CollateralSent(address _to, uint _amount);
    
    // --- Contract setters ---

    function setAddresses(
        address _borrowerOperationsAddress,
        address _liquidationsAddress,
        address _troveManagerAddress,
        address _activePoolAddress,
        address _activeShieldedPoolAddress,
        address _collateralTokenAddress
    )
        external
        override
        onlyOwner
    {
        checkContract(_borrowerOperationsAddress);
        checkContract(_liquidationsAddress);
        checkContract(_troveManagerAddress);
        checkContract(_activePoolAddress);
        checkContract(_activeShieldedPoolAddress);
        checkContract(_collateralTokenAddress);

        borrowerOperationsAddress = _borrowerOperationsAddress;
        liquidationsAddress = _liquidationsAddress;
        troveManagerAddress = _troveManagerAddress;
        activePoolAddress = _activePoolAddress;
        activeShieldedPoolAddress = _activeShieldedPoolAddress;
        collateralToken = IERC20(_collateralTokenAddress);

        emit BorrowerOperationsAddressChanged(_borrowerOperationsAddress);
        emit LiquidationsAddressChanged(_liquidationsAddress);
        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit ActivePoolAddressChanged(_activePoolAddress);
        emit ActiveShieldedPoolAddressChanged(_activeShieldedPoolAddress);
        emit CollateralTokenAddressChanged(_collateralTokenAddress);

        _renounceOwnership();
    }

    /* Returns the CT state variable at ActivePool address.
       Not necessarily equal to the raw ether balance - ether can be forcibly sent to contracts. */
    function getCollateral() external view override returns (uint256) {
        return CT;
    }

    function getCollateral(address _account) external view override returns (uint) {
        return balances[_account];
    }

    // --- Pool functionality ---

    function accountSurplus(address _account, uint _amount) external override {
        _requireCallerIsTroveManagerOrLiq();

        uint newAmount = balances[_account].add(_amount);
        balances[_account] = newAmount;

        emit CollBalanceUpdated(_account, newAmount);
    }

    function claimColl(address _account) external override returns (uint256) {
        _requireCallerIsBorrowerOperations();
        uint claimableColl = balances[_account];
        require(claimableColl > 0, "CollSurplusPool: No collateral available to claim");

        balances[_account] = 0;
        emit CollBalanceUpdated(_account, 0);

        CT = CT.sub(claimableColl);
        emit CollateralSent(_account, claimableColl);

        collateralToken.transfer(_account, claimableColl);

        return claimableColl;
    }

    function addCollateral(address _account, uint _amount) external override {
        _requireCallerIsAnActivePool();
        CT = CT.add(_amount);
        collateralToken.transferFrom(_account, address(this), _amount);
        emit CollateralSent(address(this), _amount);
    }

    // --- 'require' functions ---

    function _requireCallerIsBorrowerOperations() internal view {
        require(
            msg.sender == borrowerOperationsAddress,
            "CollSurplusPool: Caller is not Borrower Operations");
    }

    function _requireCallerIsTroveManagerOrLiq() internal view {
        require(
            msg.sender == troveManagerAddress ||
            msg.sender == liquidationsAddress,
            "CollSurplusPool: Caller is not TroveManager or Liq");
    }

    function _requireCallerIsAnActivePool() internal view {
        require(
            msg.sender == activePoolAddress ||
            msg.sender == activeShieldedPoolAddress,
            "CollSurplusPool: Caller is not an Active Pool");
    }

    function processCollateralIncrease(uint _amount) external override {
        _requireCallerIsAnActivePool();
        CT = CT.add(_amount);
        emit CollateralSent(address(this), _amount);
    }

}
