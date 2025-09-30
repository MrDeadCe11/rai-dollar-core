pragma solidity ^0.8.24;

/**
 * @title  IRDOracle
 * @notice Interface for the RDOracle hook contract
 */
interface IRDOracle {
    // --- Events ---

    /**
     * @notice Emitted when the oracle hook is called
     * @param _pool The pool address
     * @param _shouldUpdate Whether the oracle should update
     * @param _timeSinceLastUpdate Time since last update
     */
    event OracleHookCalled(address indexed _pool, bool _shouldUpdate, uint32 _timeSinceLastUpdate);

    /**
     * @notice Emitted when the oracle price is updated
     * @param _oldTick The old tick
     * @param _newTick The new tick
     * @param _oldSqrtPriceX96 The old sqrt price
     * @param _newSqrtPriceX96 The new sqrt price
     * @param _observationIndex The observation index
     */
    event OraclePriceUpdated(
        int24 _oldTick,
        int24 _newTick,
        uint160 _oldSqrtPriceX96,
        uint160 _newSqrtPriceX96,
        uint16 _observationIndex
    );

    /**
     * @notice Emitted when the relayer address is changed
     * @param _relayerAddress The new relayer address
     */
    event RelayerAddressChanged(address _relayerAddress);

    /**
     * @notice Emitted when the aggregator address is changed
     * @param _aggregatorAddress The new aggregator address
     */
    event AggregatorAddressChanged(address _aggregatorAddress);

    /**
     * @notice Emitted when the local reward is claimed
     * @param _sender The sender of the claim
     * @param _amount The amount of the claim
     */
    event OracleRewardClaimed(address _sender, uint256 _amount);

    // --- Errors ---

    /**
     * @notice Error thrown when trying to register a hook that is already registered.
     */
    error Oracle_AlreadyRegistered();

    /**
     * @notice Error thrown when the pool was not created by the allowed factory.
     * @param _pool The address of the pool.
     */
    error Oracle_PoolNotFromFactory(address _pool);

    /**
     * @notice Error thrown when trying to divide by zero
     */
    error Oracle_DivisionByZero();

    /**
     * @notice Error thrown when the oracle result is invalid
     */
    error Oracle_InvalidResult();

    /**
     * @notice Error thrown when the oracle is already initialized
     */
    error Oracle_AlreadyInitialized();

    /**
     * @notice Error thrown when slow period is not less than fast period
     */
    error Oracle_PeriodMismatch();

    /**
     * @notice Error thrown when the vault is not set
     */
    error Oracle_VaultNotSet();

    /**
     * @notice Error thrown when the RD token is not set
     */
    error Oracle_RDTokenNotSet();

    /**
     * @notice Error thrown when the stablecoin basket is empty
     */
    error Oracle_StablecoinBasketEmpty();

    /**
     * @notice Error thrown when the stablecoin basket contains a zero address
     */
    error Oracle_StablecoinBasketZeroAddress();

    /**
     * @notice Error thrown when the stablecoin is not found in the pool
     */
    error Oracle_StablecoinNotFound();

    /**
     * @notice Error thrown when the RD token is not found in the pool
     */
    error Oracle_RDTokenNotFound();

    /**
     * @notice Error thrown when the claim reward transfer fails
     */
    error Oracle_ClaimRewardTransferFailed();

    // --- Structs ---

    /**
     * @notice Struct for the oracle state
     */
    struct OracleState {
        // the current price
        uint160 sqrtPriceX96;
        // the current tick
        int24 tick;
        // the most-recently updated index of the observations array
        uint16 observationIndex;
        // the current maximum number of observations that are being stored
        uint16 observationCardinality;
        // the next maximum number of observations to store, triggered in observations.write
        uint16 observationCardinalityNext;
    }

    // --- Registry ---

    /**
     * @notice Getter for the balancer v3 pool address
     * @return _pool The pool address
     */
    function pool() external view returns (address _pool);

    /**
     * @notice Getter for the balancer v3 vault address
     * @return _vault The vault address
     */
    function vault() external view returns (address _vault);

    /**
     * @notice Getter for the RD token address
     * @return _rdToken The RD token address
     */
    function rdToken() external view returns (address _rdToken);

    /**
     * @notice Getter for the relayer address
     * @return _relayer The relayer address
     */
    function relayer() external view returns (address _relayer);

    /**
     * @notice Getter for the aggregator address
     * @return _aggregator The aggregator address
     */
    function aggregator() external view returns (address _aggregator);

    /**
     * @notice Getter for the stablecoin basket
     * @return _stablecoinBasket The stablecoin basket
     */
    function stablecoinBasket() external view returns (address[] memory _stablecoinBasket);

    // --- Data ---

    /**
     * @notice Getter for the amp value
     * @return _ampValue The amp value
     */
    function ampValue() external view returns (uint256 _ampValue);

    /**
     * @notice Getter for the amp precision
     * @return _ampPrecision The amp precision
     */
    function ampPrecision() external view returns (uint256 _ampPrecision);

    /**
     * @notice Getter for the RD token index
     * @return _rdTokenIndex The RD token index
     */
    function rdTokenIndex() external view returns (uint8 _rdTokenIndex);

    /**
     * @notice Getter for the pending local reward
     * @return _pendingLocalReward The pending local reward
     */
    function pendingLocalReward() external view returns (uint256 _pendingLocalReward);

    /**
     * @notice The fast(shorter) length of the TWAP used to consult the pool
     * @return _quotePeriod The length of the TWAP used to consult the pool
     */
    function quotePeriodFast() external view returns (uint32 _quotePeriod);

    /**
     * @notice The slow(longer) length of the TWAP used to consult the pool
     * @return _quotePeriod The length of the TWAP used to consult the pool
     */
    function quotePeriodSlow() external view returns (uint32 _quotePeriod);

    /**
     * @notice Symbol of the quote (e.g. 'RD / USD')
     * @return _symbol The symbol of the quote
     */
    function symbol() external view returns (string memory _symbol);

    /**
     * @notice Getter for the stablecoin basket indices
     * @return _stablecoinBasketIndices The stablecoin basket indices
     */
    function stablecoinBasketIndices()
        external
        view
        returns (uint8[] memory _stablecoinBasketIndices);

    /**
     * @notice Returns data about a specific observation index
     * @param index The element of the observations array to fetch
     * @dev You most likely want to use #observe() instead of this method to get an observation as of some amount of time
     * ago, rather than at a specific index in the array.
     * @return blockTimestamp The timestamp of the observation,
     * @return tickCumulative the tick multiplied by seconds elapsed for the life of the pool as of the observation timestamp,
     * @return secondsPerLiquidityCumulativeX128 the seconds per in range liquidity for the life of the pool as of the observation timestamp,
     * @return initialized whether the observation has been initialized and the values are safe to use
     */
    function observations(
        uint256 index
    )
        external
        view
        returns (
            uint32 blockTimestamp,
            int56 tickCumulative,
            uint160 secondsPerLiquidityCumulativeX128,
            bool initialized
        );

    /**
     * @notice The 0th storage slot in the pool stores many values, and is exposed as a single method to save gas
     * when accessed externally.
     * @return sqrtPriceX96 The current price of the pool as a sqrt(token1/token0) Q64.96 value
     * @return tick The current tick of the pool, i.e. according to the last tick transition that was run.
     * This value may not always be equal to SqrtTickMath.getTickAtSqrtRatio(sqrtPriceX96) if the price is on a tick
     * boundary.
     * @return observationIndex The index of the last oracle observation that was written,
     * @return observationCardinality The current maximum number of observations stored in the pool,
     * @return observationCardinalityNext The next maximum number of observations, to be updated when the observation.
     */
    function oracleState()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext
        );

    // --- Methods ---

    /**
     * @notice Set the relayer address
     * @param _relayerAddress The relayer address
     * @param _aggregatorAddress The aggregator address
     */
    function setAddresses(address _relayerAddress, address _aggregatorAddress) external;

    /**
     * @notice Fetch the latest fast oracle result and whether it is valid or not
     * @dev    This method should never revert
     * @return _result The latest fast oracle result
     * @return _validity Whether the fast oracle result is valid
     */
    function getFastResultWithValidity() external view returns (uint256 _result, bool _validity);

    /**
     * @notice Fetch the latest slow oracle result and whether it is valid or not
     * @dev    This method should never revert
     * @return _result The latest slow oracle result
     * @return _validity Whether the slow oracle result is valid
     */
    function getSlowResultWithValidity() external view returns (uint256 _result, bool _validity);

    /**
     * @notice Fetch the latest fast and slow oracle results and whether they are valid or not
     * @dev    This method should never revert
     * @return _fastResult The latest fast oracle result
     * @return _fastValidity Whether the fast oracle result is valid
     * @return _slowResult The latest slow oracle result
     * @return _slowValidity Whether the slow oracle result is valid
     */
    function getFastSlowResultWithValidity()
        external
        view
        returns (uint256 _fastResult, bool _fastValidity, uint256 _slowResult, bool _slowValidity);

    /**
     * @notice Fetch the latest fast oracle result
     * @dev    Will revert if is the price feed is invalid
     * @return _value The latest fast oracle result
     */
    function readFast() external view returns (uint256 _value);

    /**
     * @notice Fetch the latest slow oracle result
     * @dev    Will revert if is the price feed is invalid
     * @return _value The latest slow oracle result
     */
    function readSlow() external view returns (uint256 _value);

    /**
     * @notice Fetch the latest fast and slow oracle results
     * @dev    Will revert if is the price feed is invalid
     * @return _fastValue The latest slow oracle result
     * @return _slowValue The latest slow oracle result
     */
    function readFastSlow() external view returns (uint256 _fastValue, uint256 _slowValue);


    /**
     * @notice Fetch the price
     * @dev    Will revert if is the price feed is invalid
     * @return _price The price
     */
    function price() external view returns (uint256 _price);

    /**
     * @notice Fetch the last update time
     * @dev    Will revert if is the price feed is invalid
     * @return _updateTime The last update time
     */
    function getLastUpdateTime() external view returns (uint32 _updateTime);

    /**
     * @notice Returns the cumulative tick and liquidity as of each timestamp `secondsAgo` from the current block timestamp
     * @dev To get a time weighted average tick or liquidity-in-range, you must call this with two values, one representing
     * the beginning of the period and another for the end of the period. E.g., to get the last hour time-weighted average tick,
     * you must call it with secondsAgos = [3600, 0].
     * @dev The time weighted average tick represents the geometric time weighted average price of the pool, in
     * log base sqrt(1.0001) of token1 / token0. The TickMath library can be used to go from a tick value to a ratio.
     * @param _secondsAgos From how long ago each cumulative tick and liquidity value should be returned
     * @return tickCumulatives Cumulative tick values as of each `_secondsAgos` from the current block timestamp
     * @return secondsPerLiquidityCumulativeX128s This is 0 as it's not implemented
     */
    function observe(
        uint32[] calldata _secondsAgos
    )
        external
        view
        returns (
            int56[] memory tickCumulatives,
            uint160[] memory secondsPerLiquidityCumulativeX128s
        );

    /**
     * @notice Increase the observation cardinality next
     * @param _observationCardinalityNext The new observation cardinality next
     * @return _observationCardinalityNextOld The old observation cardinality next
     * @return _observationCardinalityNextNew The new observation cardinality next
     */
    function increaseObservationCardinalityNext(
        uint16 _observationCardinalityNext
    )
        external
        returns (uint16 _observationCardinalityNextOld, uint16 _observationCardinalityNextNew);
}
