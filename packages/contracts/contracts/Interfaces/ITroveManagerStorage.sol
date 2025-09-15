    // SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./ILiquityBase.sol";
import "./IStabilityPool.sol";
import "./IActivePool.sol";
import "./IDefaultPool.sol";
import "./ILUSDToken.sol";
import "./ILQTYToken.sol";
import "./ILQTYStaking.sol";
import "./IRelayer.sol";
import "./ICollSurplusPool.sol";
import "./IAggregator.sol";
import "./ISortedTroves.sol";
import "./IGlobalFeeRouter.sol";
import "./IFeeRouter.sol";
import "./ILiquidations.sol";
import "./IRewards.sol";
import "../Dependencies/IERC20.sol";
import "./IBorrowerOperations.sol";
import "./IStabilityPool.sol";
import "./ICollSurplusPool.sol";

// Common interface for the Trove Manager.
interface ITroveManagerStorage is ILiquityBase {
    
    enum Status {
        nonExistent,
        active,
        closedByOwner,
        closedByLiquidation,
        closedByRedemption
    }

    struct ContractsStorage { 
        IAggregator aggregator;
        ILiquidations liquidations;
        IStabilityPool stabilityPool;
        IDefaultPool defaultPool;
        ICollSurplusPool collSurplusPool;
        ILUSDToken lusdToken;
        ILQTYToken lqtyToken;
        ILQTYStaking lqtyStaking;
        ISortedTroves sortedTroves;
        ISortedTroves sortedShieldedTroves;
        IERC20 collateralToken;
        IFeeRouter feeRouter;
        IGlobalFeeRouter globalFeeRouter;
        IRewards rewards;
        address gasPoolAddress;
        address borrowerOperationsAddress;
    }

    struct Trove {
        uint debt;
        uint coll;
        uint stake;
        Status status;
        uint128 arrayIndex;
    }

    struct TroveStorage {
        mapping (address => Trove) Troves;
        mapping (address => bool) shielded;
        address[] TroveOwners;
        address[] ShieldedTroveOwners;
    }

    // struct ConstantsStorage {
    //     uint internal constant REDEMPTION_FEE_FLOOR = DECIMAL_PRECISION / 1000 * 5; // 0.5%
    //     uint internal constant DRIP_STALENESS_THRESHOLD = 1 hours;
    //     uint internal constant kappa = 15 * 10**17; // 1.5
    //     uint public constant stakeRevenueAllocation = 25*10**16; // 25%
    //     // accumulated interest rate
    //     uint public override accumulatedRate = RATE_PRECISION;
    //     // accumulated interest rate for shielded troves
    //     uint public override accumulatedShieldRate = RATE_PRECISION;
    //     uint public lastAccRateUpdateTime = block.timestamp;
    // }

    // struct RateStorage {
    //     uint public override accumulatedRate = RATE_PRECISION;
    //     uint public override accumulatedShieldRate = RATE_PRECISION;
    //     uint public lastAccRateUpdateTime = block.timestamp;
    // }

}