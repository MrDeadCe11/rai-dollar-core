// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FixedPoint} from "./Vendor/@balancer-labs/v3-solidity-utils/contracts/math/FixedPoint.sol";
import {Arrays} from "./Vendor/@balancer-labs/dependencies/@openzeppelin/contracts/utils/Arrays.sol";
import {Math} from "./Vendor/@balancer-labs/dependencies/@openzeppelin/contracts/utils/math/Math.sol";

import {BaseHooks} from "./Vendor/@balancer-labs/v3-vault/contracts/BaseHooks.sol";

import {IHooks} from "./Vendor/@balancer-labs/v3-interfaces/contracts/vault/IHooks.sol";
import {IVault} from "./Vendor/@balancer-labs/v3-interfaces/contracts/vault/IVault.sol";

import {VaultGuard} from "./Vendor/@balancer-labs/v3-vault/contracts/VaultGuard.sol";
import {HookFlags, TokenConfig, LiquidityManagement, AddLiquidityKind, RemoveLiquidityKind, PoolSwapParams} from "./Vendor/@balancer-labs/v3-interfaces/contracts/vault/VaultTypes.sol";

import {BasePoolFactory} from "./Vendor/@balancer-labs/v3-pool-utils/contracts/BasePoolFactory.sol";
import {StablePool, Rounding} from "./Vendor/@balancer-labs/v3-pool-stable/contracts/StablePool.sol";

import {Oracle} from "./Vendor/@uniswap/v3-core/contracts/libraries/Oracle.sol";
import {TickMath} from "./Vendor/@uniswap/v3-core/contracts/libraries/TickMath.sol";

import {IRelayer} from "./v0.8.24/Interfaces/IRelayer.sol";
import {IAggregator} from "./v0.8.24/Interfaces/IAggregator.sol";
import {ILUSDToken} from "./v0.8.24/Interfaces/ILUSDToken.sol";
import {Ownable} from "./v0.8.24/Dependencies/Ownable.sol";
import {CheckContract} from "./v0.8.24/Dependencies/CheckContract.sol";

import {IERC20} from "./v0.8.24/Dependencies/IERC20.sol";

import {IRDOracle} from "./Interfaces/IRDOracle.sol";

// Note: If > 50% of tokens in pool are yield bearing must use rate provider for token
//  https://docs.balancer.fi/partner-onboarding/onboarding-overview/rate-providers.html

contract RDOracle is IRDOracle, BaseHooks, VaultGuard, Ownable, CheckContract {
    using FixedPoint for uint256;
    using Math for uint256;
    using Arrays for uint256[];
    using Oracle for Oracle.Observation[65535];

    /// @inheritdoc IRDOracle
    OracleState public override oracleState;

    // --- Constants ---

    /**
     * @notice Name of the contract
     */
    string public constant NAME = "RDOracle";

    /**
     * @notice The constant WAD.
     */
    uint256 internal constant _WAD = 1e18;

    /**
     * @notice Minimum age to use in TWAP
     */
    uint32 internal constant _MIN_PRICE_AGE = 60;

    // --- Registry ---

    /// @inheritdoc IRDOracle
    address public pool;

    /// @inheritdoc IRDOracle
    address public vault;

    /// @inheritdoc IRDOracle
    address public rdToken;

    /// @inheritdoc IRDOracle
    address public relayer;

    /// @inheritdoc IRDOracle
    address public aggregator;

    address[] internal _stablecoinBasket;

    /**
     * @notice Getter for the stablecoin basket
     * @inheritdoc IRDOracle
     */
    function stablecoinBasket() external view override returns (address[] memory) {
        return _stablecoinBasket;
    }

    // --- Data ---

    /// @inheritdoc IRDOracle
    uint256 public ampValue;

    /// @inheritdoc IRDOracle
    uint256 public ampPrecision;

    /// @inheritdoc IRDOracle
    uint8 public rdTokenIndex;

    /// @inheritdoc IRDOracle
    uint256 public pendingLocalReward;

    uint8[] internal _stablecoinBasketIndices;

    /**
     * @notice Getter for the stablecoin basket indices
     * @inheritdoc IRDOracle
     */
    function stablecoinBasketIndices() external view override returns (uint8[] memory) {
        return _stablecoinBasketIndices;
    }

    /// @inheritdoc IRDOracle
    Oracle.Observation[65535] public override observations;

    /// @inheritdoc IRDOracle
    uint32 public override quotePeriodSlow;
    uint32 public override quotePeriodFast;

    /// @inheritdoc IRDOracle
    string public symbol = "RD / USD";

    // --- Init ---

    /**
     * @param  _vault Address of the vault
     * @param  _rdToken Address of the RD token
     * @param  _quotePeriodSlow Length in seconds of the TWAP used to consult the pool
     * @param  _quotePeriodFast Length in seconds of the TWAP used to consult the pool
     * @param  _stablecoins Array of addresses of the stablecoins in the pool
     */
    constructor(
        address _vault,
        address _rdToken,
        uint32 _quotePeriodFast,
        uint32 _quotePeriodSlow,
        address[] memory _stablecoins
    ) VaultGuard(IVault(_vault)) {
        if (_quotePeriodFast >= _quotePeriodSlow) {
            revert Oracle_PeriodMismatch();
        }
        if (_vault == address(0)) {
            revert Oracle_VaultNotSet();
        }
        if (_rdToken == address(0)) {
            revert Oracle_RDTokenNotSet();
        }
        if (_stablecoins.length == 0) {
            revert Oracle_StablecoinBasketEmpty();
        }
        for (uint256 i = 0; i < _stablecoins.length; i++) {
            if (_stablecoins[i] == address(0)) {
                revert Oracle_StablecoinBasketZeroAddress();
            }
        }
        vault = _vault;
        rdToken = _rdToken;
        _stablecoinBasket = _stablecoins;
        quotePeriodFast = _quotePeriodFast;
        quotePeriodSlow = _quotePeriodSlow;
        // Initialize oracle state with price of 1 RD/USD
        _initialize(2 ** 96);
        // _initialize(_convertPriceToSqrtPriceX96(_WAD));
    }

    // --- Hooks ---

    /// @inheritdoc IHooks
    function onRegister(
        address _factory,
        address _pool,
        TokenConfig[] memory _tokenConfigs,
        LiquidityManagement calldata
    ) public override onlyVault returns (bool) {
        if (pool != address(0)) {
            revert Oracle_AlreadyRegistered();
        }
        pool = _pool;

        StablePool _stablePool = StablePool(pool);
        (uint256 _ampValue, , uint256 _ampPrecision) = _stablePool.getAmplificationParameter();
        ampValue = _ampValue;
        ampPrecision = _ampPrecision;

        // Check if pool was created by the allowed factory.
        if (!BasePoolFactory(_factory).isPoolFromFactory(_pool)) {
            revert Oracle_PoolNotFromFactory(_pool);
        }

        // Initialize rdTokenIndex and _stablecoinBasketIndices
        bool _rdTokenFound = false;
        _stablecoinBasketIndices = new uint8[](_stablecoinBasket.length);

        for (uint256 j = 0; j < _stablecoinBasket.length; ++j) {
            address stablecoinToFind = _stablecoinBasket[j];
            bool foundThisStablecoinInPool = false;
            for (uint256 i = 0; i < _tokenConfigs.length; ++i) {
                if (address(_tokenConfigs[i].token) == stablecoinToFind) {
                    _stablecoinBasketIndices[j] = uint8(i);
                    foundThisStablecoinInPool = true;
                    break;
                }
            }
            if (!foundThisStablecoinInPool) {
                revert Oracle_StablecoinNotFound();
            }
        }

        // Find the pool index for rdToken
        for (uint256 i = 0; i < _tokenConfigs.length; ++i) {
            if (address(_tokenConfigs[i].token) == rdToken) {
                rdTokenIndex = uint8(i);
                _rdTokenFound = true;
                break;
            }
        }

        if (!_rdTokenFound) {
            revert Oracle_RDTokenNotFound();
        }

        return true;
    }

    /// @inheritdoc BaseHooks
    function getHookFlags() public pure override returns (HookFlags memory hookFlags_) {
        hookFlags_.shouldCallBeforeSwap = true;
        hookFlags_.shouldCallBeforeAddLiquidity = true;
        hookFlags_.shouldCallBeforeRemoveLiquidity = true;
        return hookFlags_;
    }

    /// @inheritdoc BaseHooks
    function onBeforeSwap(
        PoolSwapParams calldata,
        address _pool
    ) public override onlyVault returns (bool _success) {
        _onHookCalled(_pool);
        return (true);
    }

    /// @inheritdoc BaseHooks
    function onBeforeAddLiquidity(
        address,
        address _pool,
        AddLiquidityKind,
        uint256[] memory,
        uint256,
        uint256[] memory,
        bytes memory
    ) public override onlyVault returns (bool) {
        _onHookCalled(_pool);
        return (true);
    }

    /// @inheritdoc BaseHooks
    function onBeforeRemoveLiquidity(
        address,
        address _pool,
        RemoveLiquidityKind,
        uint256,
        uint256[] memory,
        uint256[] memory,
        bytes memory
    ) public override onlyVault returns (bool) {
        _onHookCalled(_pool);
        return (true);
    }

    /**
     * @notice Update the synthetic RD price if the hook was called
     * @param  _pool The pool address
     */
    function _onHookCalled(address _pool) internal {
        // If time since last observation > minDelta then update price in observations
        bool _shouldUpdateOracle = false;

        uint32 _now = _blockTimestamp();

        uint16 _observationIndex = oracleState.observationIndex;
        (uint32 _lastUpdateTime, , , ) = this.observations(_observationIndex);

        uint32 _timeSinceLastUpdate = _now - _lastUpdateTime;

        if (_now > _lastUpdateTime) {
            _shouldUpdateOracle = true;
        }

        // Emit event for debugging
        emit OracleHookCalled(_pool, _shouldUpdateOracle, _timeSinceLastUpdate);

        if (_shouldUpdateOracle) {
            // Get last balances of all tokens in the pool
            (, , , uint256[] memory _lastBalancesWad) = IVault(vault).getPoolTokenInfo(_pool);
            _updateSyntheticRDPrice(_lastBalancesWad);

            if (relayer != address(0)) {
                _checkAndUpdateRelayer();
            }

            if (aggregator != address(0)) {
                _checkAndUpdateAggregator();
            }
        }
    }

    /**
     * @notice Check and update the aggregator
     */
    function _checkAndUpdateAggregator() internal {
        (bool shouldOracleDrip, uint256 oracleDripReward) = IAggregator(aggregator)
            .shouldOracleDrip();

        bool _didDrip = false;

        if (shouldOracleDrip) {
            IAggregator(aggregator).drip();
            _didDrip = true;
        }

        if (_didDrip) {
            pendingLocalReward += oracleDripReward;
        }
    }

    /**
     * @notice Check and update the relayer
     */
    function _checkAndUpdateRelayer() internal {
        (bool shouldUpdateRate, bool shouldUpdatePar, uint256 updateReward) = IRelayer(relayer)
            .shouldUpdateRateAndPar();

        (uint256 fastVal, bool fastOk, uint256 slowVal, bool slowOk) = this
            .getFastSlowResultWithValidity();

        bool _didUpdate = false;

        // Update the relayer - Rate control uses the fast TWAP, Par control uses the slow TWAP
        if (shouldUpdateRate && shouldUpdatePar && fastOk && slowOk) {
            IRelayer(relayer).updateRateAndParWithMarket(fastVal, slowVal);
            _didUpdate = true;
        } else if (shouldUpdateRate && fastOk) {
            IRelayer(relayer).updateRateWithMarket(fastVal);
            _didUpdate = true;
        } else if (shouldUpdatePar && slowOk) {
            IRelayer(relayer).updateParWithMarket(slowVal);
            _didUpdate = true;
        }

        if (_didUpdate) {
            pendingLocalReward += updateReward;
        }
    }

    /**
     * @notice Send the caller reward
     */
    function claimLocalReward() external {
        uint256 owed = pendingLocalReward;
        if (owed == 0) return;

        uint256 bal = IERC20(rdToken).balanceOf(address(this));
        uint256 pay = bal < owed ? bal : owed;
        if (pay == 0) return;

        pendingLocalReward = owed - pay; // keep the remaining owed amount
        bool ok = IERC20(rdToken).transfer(msg.sender, pay);
        if (!ok) revert Oracle_ClaimRewardTransferFailed();

        emit OracleRewardClaimed(msg.sender, pay);
    }

    // --- Dependency setter ---

    /// @inheritdoc IRDOracle
    function setAddresses(address _relayerAddress, address _aggregatorAddress) external onlyOwner {
        checkContract(_relayerAddress);
        checkContract(_aggregatorAddress);

        relayer = _relayerAddress;
        aggregator = _aggregatorAddress;

        emit RelayerAddressChanged(_relayerAddress);
        emit AggregatorAddressChanged(_aggregatorAddress);

        _renounceOwnership();
    }

    // --- Methods ---

    /// @inheritdoc IRDOracle
    function getFastResultWithValidity() public view returns (uint256 _result, bool _validity) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = quotePeriodFast;
        secondsAgos[1] = _MIN_PRICE_AGE;
        try this.observe(secondsAgos) returns (int56[] memory tickCumulatives, uint160[] memory) {
            int56 delta = tickCumulatives[1] - tickCumulatives[0];
            int24 meanTick = int24(delta / int56(int32(quotePeriodFast - _MIN_PRICE_AGE)));
            uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(meanTick);
            return (_convertSqrtPriceX96ToPrice(sqrtPriceX96), true);
        } catch {
            return (0, false);
        }
    }

    /// @inheritdoc IRDOracle
    function readFast() external view returns (uint256 _result) {
        (uint256 _fastResult, bool _validity) = this.getFastResultWithValidity();
        if (!_validity) {
            revert Oracle_InvalidResult();
        }
        return _fastResult;
    }

    /// @inheritdoc IRDOracle
    function getSlowResultWithValidity() public view returns (uint256 _result, bool _validity) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = quotePeriodSlow;
        secondsAgos[1] = _MIN_PRICE_AGE;
        try this.observe(secondsAgos) returns (int56[] memory tickCumulatives, uint160[] memory) {
            int56 delta = tickCumulatives[1] - tickCumulatives[0];
            int24 meanTick = int24(delta / int56(int32(quotePeriodSlow - _MIN_PRICE_AGE)));
            uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(meanTick);
            return (_convertSqrtPriceX96ToPrice(sqrtPriceX96), true);
        } catch {
            return (0, false);
        }
    }

    /// @inheritdoc IRDOracle
    function readSlow() external view returns (uint256 _result) {
        (uint256 _slowResult, bool _validity) = this.getSlowResultWithValidity();
        if (!_validity) {
            revert Oracle_InvalidResult();
        }
        return _slowResult;
    }

    /// @inheritdoc IRDOracle
    function getFastSlowResultWithValidity()
        external
        view
        returns (uint256 _fastResult, bool _fastValidity, uint256 _slowResult, bool _slowValidity)
    {
        // If the pool doesn't have enough history return false
        (_fastResult, _fastValidity) = getFastResultWithValidity();
        (_slowResult, _slowValidity) = getSlowResultWithValidity();
    }

    /// @inheritdoc IRDOracle
    function readFastSlow() external view returns (uint256 _fastValue, uint256 _slowValue) {
        (uint256 _fastResult, bool _fastValidity) = this.getFastResultWithValidity();
        (uint256 _slowResult, bool _slowValidity) = this.getSlowResultWithValidity();
        if (!_fastValidity || !_slowValidity) {
            revert Oracle_InvalidResult();
        }

        return (_fastResult, _slowResult);
    }

    /// @inheritdoc IRDOracle
    function price() external view returns (uint256 _price) {
        (uint256 value, bool ok) = this.getFastResultWithValidity();
        if (!ok) {
            // fallback to current stored sqrtPrice (or 1e18 if uninitialized)
            return
                oracleState.sqrtPriceX96 == 0
                    ? 1e18
                    : _convertSqrtPriceX96ToPrice(oracleState.sqrtPriceX96);
        }
        return value;
    }

    /// @inheritdoc IRDOracle
    function getLastUpdateTime() external view returns (uint32 _updateTime) {
        uint16 _observationIndex = oracleState.observationIndex;
        (uint32 _lastUpdateTime, , , ) = this.observations(_observationIndex);
        return _lastUpdateTime;
    }

    /// @inheritdoc IRDOracle
    function observe(
        uint32[] calldata _secondsAgos
    )
        external
        view
        override
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        return
            observations.observe(
                _blockTimestamp(),
                _secondsAgos,
                oracleState.tick,
                oracleState.observationIndex,
                0,
                oracleState.observationCardinality
            );
    }

    /// @inheritdoc IRDOracle
    function increaseObservationCardinalityNext(
        uint16 _observationCardinalityNext
    )
        external
        returns (uint16 _observationCardinalityNextOld, uint16 _observationCardinalityNextNew)
    {
        _observationCardinalityNextOld = oracleState.observationCardinalityNext;
        _observationCardinalityNextNew = observations.grow(
            _observationCardinalityNextOld,
            _observationCardinalityNext
        );
        oracleState.observationCardinalityNext = _observationCardinalityNextNew;
    }

    /**
     * @notice Initialize the oracle
     * @param  _sqrtPriceX96 The sqrtPriceX96 value
     */
    function _initialize(uint160 _sqrtPriceX96) internal {
        if (oracleState.sqrtPriceX96 != 0) {
            revert Oracle_AlreadyInitialized();
        }

        int24 _tick = TickMath.getTickAtSqrtRatio(_sqrtPriceX96);

        (uint16 _cardinality, uint16 _cardinalityNext) = observations.initialize(_blockTimestamp());

        oracleState = OracleState({
            sqrtPriceX96: _sqrtPriceX96,
            tick: _tick,
            observationIndex: 0,
            observationCardinality: _cardinality,
            observationCardinalityNext: _cardinalityNext
        });
    }

    /**
     * @notice Update the synthetic RD price
     * @param  _lastBalancesWad The last balances of the pool
     */
    function _updateSyntheticRDPrice(uint256[] memory _lastBalancesWad) internal {
        // TODO: Implement price update
        uint256 _currentSyntheticRDPriceWad = _calculateInstantaneousSyntheticRDPrice(
            _lastBalancesWad
        );
        uint160 _sqrtPriceX96 = _convertPriceToSqrtPriceX96(_currentSyntheticRDPriceWad);
        int24 _tick = TickMath.getTickAtSqrtRatio(_sqrtPriceX96);

        // Store old values for event emission
        int24 _oldTick = oracleState.tick;
        uint160 _oldSqrtPriceX96 = oracleState.sqrtPriceX96;

        (uint16 observationIndex, uint16 observationCardinality) = observations.write(
            oracleState.observationIndex,
            _blockTimestamp(),
            _oldTick,
            0,
            oracleState.observationCardinality,
            oracleState.observationCardinalityNext
        );
        (
            oracleState.sqrtPriceX96,
            oracleState.tick,
            oracleState.observationIndex,
            oracleState.observationCardinality
        ) = (_sqrtPriceX96, _tick, observationIndex, observationCardinality);

        // Emit event for debugging
        emit OraclePriceUpdated(_oldTick, _tick, _oldSqrtPriceX96, _sqrtPriceX96, observationIndex);
    }

    /**
     * @notice Convert a price to a sqrtPriceX96 value
     *
     * @dev
     *
     *         sqrtPriceX96 is a Q64.96 fixed-point number representing the square root of the price
     *         sqrtPriceX96 = sqrt(price) * 2^96
     *
     * @param  _price The price to convert
     * @return _sqrtPriceX96 The sqrtPriceX96 value
     */
    function _convertPriceToSqrtPriceX96(
        uint256 _price
    ) internal pure returns (uint160 _sqrtPriceX96) {
        uint256 _ratio = (_price << 192) / _WAD;
        return uint160(Math.sqrt(_ratio));
    }

    /**
     * @notice Convert a sqrtPriceX96 value to a price
     * @param  _sqrtPriceX96 The sqrtPriceX96 value
     * @return _price The price
     */
    function _convertSqrtPriceX96ToPrice(
        uint160 _sqrtPriceX96
    ) internal pure returns (uint256 _price) {
        uint256 _numerator = uint256(_sqrtPriceX96) * uint256(_sqrtPriceX96) * _WAD;
        return _numerator >> 192;
    }

    /**
     * @notice Get the instantaneous synthetic RD price
     * @param  _lastBalancesWad The last balances of the pool
     * @return _syntheticRDPriceWad The instantaneous synthetic RD price
     */
    function _calculateInstantaneousSyntheticRDPrice(
        uint256[] memory _lastBalancesWad
    ) internal view returns (uint256 _syntheticRDPriceWad) {
        StablePool _pool = StablePool(pool);
        uint256 _numBalances = _lastBalancesWad.length;

        uint256 _poolInvariant = _pool.computeInvariant(_lastBalancesWad, Rounding.ROUND_UP);
        uint256 _ampCoefficient = (_numBalances ** _numBalances) * ampValue;

        uint256 _balancesSum;
        for (uint256 _i = 0; _i < _numBalances; _i++) {
            _balancesSum += _lastBalancesWad[_i];
        }

        // Calculate partial derivative for RD
        uint256 _derivativeRD = _calculatePartialDerivative(
            _lastBalancesWad[rdTokenIndex],
            _ampCoefficient,
            _poolInvariant,
            _balancesSum,
            ampPrecision
        );

        uint256[] memory _stablePricesInRD = new uint256[](_stablecoinBasket.length);

        for (uint256 _i = 0; _i < _stablecoinBasket.length; _i++) {
            uint8 _stableIndex = _stablecoinBasketIndices[_i];
            uint256 _stableBalanceWad = _lastBalancesWad[_stableIndex];

            // Calculate partial derivative for this stablecoin
            uint256 _derivativeStablecoin = _calculatePartialDerivative(
                _stableBalanceWad,
                _ampCoefficient,
                _poolInvariant,
                _balancesSum,
                ampPrecision
            );

            if (_derivativeStablecoin == 0) {
                revert Oracle_DivisionByZero();
            }

            // Price of stablecoin _i in terms of RD = _derivativeRD / _derivativeStablecoin
            uint256 _priceStableInRD = _derivativeRD.divDown(_derivativeStablecoin);

            _stablePricesInRD[_i] = _priceStableInRD;
        }

        uint256 _medianBasketPriceInRD = _calculateMedian(_stablePricesInRD);

        if (_medianBasketPriceInRD == 0) {
            revert Oracle_DivisionByZero();
        }

        // Synthetic Price RD/USD = 1 / medianBasketPriceInRD
        // Use WAD * WAD / x for 1/x equivalent, preserves WAD scaling
        _syntheticRDPriceWad = _WAD.mulDown(_WAD).divDown(_medianBasketPriceInRD);

        return _syntheticRDPriceWad;
    }

    /**
     * @notice Returns the block timestamp truncated to 32 bits, i.e. mod 2**32.
     * @return _blockTimestamp The block timestamp
     */
    function _blockTimestamp() internal view virtual returns (uint32) {
        return uint32(block.timestamp); // truncation is desired
    }

    /**
     * @notice Calculates the median of an array of uint256 values.
     * @param _arr An array of WAD-scaled prices.
     * @return The median value. For an even number of elements, returns the lower of the two middle elements.
     */
    function _calculateMedian(uint256[] memory _arr) internal pure returns (uint256) {
        uint256 a = _arr[0];
        uint256 b = _arr[1];
        uint256 c = _arr[2];
        if ((a >= b && a <= c) || (a >= c && a <= b)) return a;
        if ((b >= a && b <= c) || (b >= c && b <= a)) return b;
        return c;
    }

    /**
     * @notice Calculate the partial derivative of the stable pool invariant for a given token
     * @dev    See Balancer v3 Stable Math Resources:
     *
     *         - https://docs.balancer.fi/concepts/explore-available-balancer-pools/stable-pool/stable-math.html#overview
     *         - https://github.com/georgeroman/balancer-v2-pools/blob/main/src/pools/stable/math.ts#L16
     *         - https://berkeley-defi.github.io/assets/material/StableSwap.pdf
     *
     * @dev
     *
     *         D = invariant (a measure of the total value in the pool)
     *         A = amplification coefficient
     *         S = sum of all token balances (x_1 + x_2 + ... + x_n)
     *         P = product of all token balances (x_1 * x_2 * ... * x_n)
     *         n = number of tokens
     *
     *         The StableSwap invariant equation is:
     *
     *         A * n^n * S + D = A * n^n * D + D^(n+1) / (n^n * P)
     *
     *         The derivative formula is:
     *
     *           df                  D^(n+1)                 1
     *         ------ = n^n * A + ------------- = n^n * A + --- * (n^n * A * S + D - n^n * A * D)
     *           dx                n^n * x * P               x
     *
     *         From the StableSwap invariant equation we isolate D^(n+1) / (n^n * P) by moving A * n^n * D to the left
     *         side of the equation, which gives us the following identity:
     *
     *         D^(n+1) / (n^n * P) = A * n^n * S + D - A * n^n * D
     *
     *         We can then rewrite the second term of the derivative formula as:
     *
     *         [ D^(n+1) / (n^n * P) ] * (1/x)
     *
     *         We then substitute the previously derived identity into the second term of the derivative formula:
     *
     *         df/dx = n^n * A + [ A * n^n * S + D - A * n^n * D ] * (1/x)
     *
     *         df/dx = n^n * A + (A * n^n * S + D - A * n^n * D) / x
     *
     *
     * @param  _tokenBalance The balance of the token
     * @param  _ampCoefficient The amplification coefficient (n^n * A)
     * @param  _poolInvariant The pool invariant (D)
     * @param  _balancesSum The sum of the balances of the pool (S)
     * @param  _ampPrecision The precision of the amplification coefficient
     * @return _partialDerivative The partial derivative for the token
     */
    function _calculatePartialDerivative(
        uint256 _tokenBalance,
        uint256 _ampCoefficient,
        uint256 _poolInvariant,
        uint256 _balancesSum,
        uint256 _ampPrecision
    ) internal pure returns (uint256 _partialDerivative) {
        if (_balancesSum == 0) {
            revert Oracle_DivisionByZero();
        }

        // The amplification parameter A is a dimensionless number that controls how
        // closely the pool's behavior mimics a constant-sum invariant (like x+y=k)
        // versus a constant-product invariant (like x*y=k)

        // _ampPrecision is a scaling factor that ensures the amplification coefficient
        // is represented in a fixed-point format (e.g. no decimals)

        // The amplification value stored in the contract is scaled by _ampPrecision
        // so we need to scale it down to WAD precision when calculating the partial
        // derivative
        //
        // True A value = A value in contract / _ampPrecision

        // Term 1 = n^n * A = _ampCoefficient
        // _ampCoefficient * (WAD / _ampPrecision) -> A is scaled to WAD precision
        uint256 term1 = FixedPoint.mulDown(_ampCoefficient, _WAD).divDown(_ampPrecision);

        // Term 2 Total = (A * n^n * S + D - A * n^n * D) / x
        // Term 2 Numerator = A * n^n * S + D - A * n^n * D
        // Term 2 Numerator Part 1 = A * n^n * S
        // Term 2 Numerator Part 2 = D
        // Term 2 Numerator Part 3 = A * n^n * D

        uint256 term2NumPart1 = FixedPoint.mulDown(_ampCoefficient, _balancesSum).divDown(
            _ampPrecision
        );
        uint256 term2NumPart2 = _poolInvariant;
        uint256 term2NumPart3 = FixedPoint.mulDown(_ampCoefficient, _poolInvariant).divDown(
            _ampPrecision
        );

        uint256 term2Numerator = term2NumPart1 + term2NumPart2 - term2NumPart3;

        // Term 2 = term2Numerator / _tokenBalance
        uint256 term2 = term2Numerator.divDown(_tokenBalance);

        return term1 + term2;
    }
}
