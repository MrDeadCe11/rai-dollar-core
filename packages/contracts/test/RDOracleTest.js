const { expect } = require("chai");
const { BN, expectEvent, time } = require("@openzeppelin/test-helpers");
const { ethers } = require("hardhat");
const { Decimal } = require("decimal.js");
const _BN = require("bn.js");

const testHelpers = require("../utils/testHelpers.js");

const th = testHelpers.TestHelper;
const assertRevert = th.assertRevert;

const RDOracleTestHelper = artifacts.require("./TestContracts/RDOracleTestHelper.sol");
const RDOracle = artifacts.require("./RDOracle.sol");
const Vault = artifacts.require("./Vendor/@balancer-labs/v3-vault/contracts/Vault.sol");
const IVault = artifacts.require("./Vendor/@balancer-labs/v3-interfaces/contracts/vault/IVault.sol");

const StablePoolFactory = artifacts.require(
  "./Vendor/@balancer-labs/v3-pool-stable/contracts/StablePoolFactory.sol"
);
const StablePool = artifacts.require(
  "./Vendor/@balancer-labs/v3-pool-stable/contracts/StablePool.sol"
);
const Router = artifacts.require("./Vendor/@balancer-labs/v3-vault/contracts/Router.sol");

const ERC20 = artifacts.require("@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20");
const MockERC20 = artifacts.require(
  "./Vendor/@balancer-labs/dependencies/@openzeppelin/contracts/token/ERC20/MockERC20.sol"
);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// const DEFAULT_AMP_FACTOR = 1000;
const DEFAULT_AMP_FACTOR = 10;
const BASE_MIN_SWAP_FEE = 1e12; // 0.001% (in WAD)

const TokenType = {
  STANDARD: 0,
  WITH_RATE: 1
};

const USDC_DECIMALS = 6;
const USDT_DECIMALS = 6;
const DAI_DECIMALS = 18;
const RD_DECIMALS = 18;

const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const anvilAccount1 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const swapperAccount = anvilAccount1; // The account that will perform swaps and provide initial liquidity

contract("RDOracle", async accounts => {
  let mockRD, mockUSDC, mockUSDT, mockDAI;
  let rdAddress, usdcAddress, usdtAddress, daiAddress;
  let RDTAddress, USDCAddress, USDTAddress, DAIAddress;
  let sortedAddresses, stablecoins;
  let RD, USDC, USDT, DAI;
  let vault, iVault, rdOracle, stablePoolFactory;
  let newPoolAddress, poolId;

  const provider = new ethers.providers.JsonRpcProvider();
  const ethersSigner = provider.getSigner(anvilAccount1);

  const QUOTE_PERIOD_FAST = 300; // 5 minutes
  const QUOTE_PERIOD_SLOW = 900; // 15 minutes
  const MIN_OBSERVATION_DELTA = 60; // 1 minute

  const balv3StablePoolFactory = "0xB9d01CA61b9C181dA1051bFDd28e1097e920AB14";
  const balv3Vault = "0xbA1333333333a1BA1108E8412f11850A5C319bA9";
  const balv3Router = "0xAE563E3f8219521950555F5962419C8919758Ea2";

  const logsOn = true;

  async function setupBalancerContracts(logSetup = false) {
    const showLogs = logsOn && logSetup;
    vault = await Vault.at(balv3Vault);
    iVault = await IVault.at(balv3Vault);
    router = await Router.at(balv3Router);
    stablePoolFactory = await StablePoolFactory.at(balv3StablePoolFactory);

    if (showLogs) {
      console.log("Setup Balancer Contracts");
      console.log("Vault:", vault.address);
      console.log("Router:", router.address);
      console.log("StablePoolFactory:", stablePoolFactory.address);
    }
  }

  async function logOracleState(oracleState) {
    console.log("Oracle State:", {
      sqrtPriceX96: oracleState.sqrtPriceX96.toString(),
      tick: oracleState.tick.toString(),
      observationIndex: oracleState.observationIndex.toString(),
      observationCardinality: oracleState.observationCardinality.toString(),
      observationCardinalityNext: oracleState.observationCardinalityNext.toString()
    });
  }

  function createTruffleTokenConfig(
    tokenAddress,
    tokenType = TokenType.STANDARD,
    rateProvider = ethers.constants.AddressZero,
    paysYieldFees = false
  ) {
    return [tokenAddress, tokenType, rateProvider, paysYieldFees];
  }

  async function executeSwap({
    signer,
    newPoolAddress,
    _amountIn,
    _minAmountOut,
    tokenIn,
    tokenOut,
    tokenInDecimals,
    tokenOutDecimals
  }) {
    const swapperAccount = anvilAccount1;
    const amountIn = ethers.utils.parseUnits(_amountIn, tokenInDecimals);
    const tokenInBalance = await tokenIn.balanceOf(anvilAccount1);

    if (tokenInBalance.lt(amountIn)) {
      console.warn(
        `Swapper account ${anvilAccount1} has ${tokenInBalance.toString()} ${
          tokenIn.symbol
        }, needs ${_amountIn} ${
          tokenIn.symbol
        } for swap. Test may fail or be misleading if account is not funded externally.`
      );
    }

    const minAmountOut = ethers.utils.parseUnits(_minAmountOut, tokenOutDecimals);

    const latestTimestamp = (await time.latest()).toNumber();
    const deadline = latestTimestamp + 3600; // 1 hour

    const permit2Contract = new ethers.Contract(
      PERMIT2_ADDRESS,
      [
        "function approve(address token, address spender, uint160 amount, uint48 expiration) external"
      ],
      signer
    );

    const expiration = Math.floor(Date.now() / 1000) + 86400; // 24 hours

    await permit2Contract.approve(tokenIn.address, router.address, amountIn.toString(), expiration);

    try {
      swapTx = await router.swapSingleTokenExactIn(
        newPoolAddress, // pool address
        tokenIn.address, // tokenIn
        tokenOut.address, // tokenOut
        amountIn, // exactAmountIn
        minAmountOut, // minAmountOut
        deadline, // deadline
        false, // wethIsEth
        "0x", // userData
        { from: swapperAccount }
      );
      return swapTx;
    } catch (e) {
      const tokenInAllowanceToPermit2 = await tokenIn.allowance(swapperAccount, PERMIT2_ADDRESS);
      console.error(
        `Router swap transaction failed for swapper ${swapperAccount}.\n` +
          `${tokenIn.symbol} Balance: ${tokenInBalance.toString()} ${
            tokenIn.symbol
          } (need ${amountIn.toString()} ${tokenIn.symbol}).\n` +
          `${tokenIn.symbol} Allowance to Permit2: ${tokenInAllowanceToPermit2.toString()} ${
            tokenIn.symbol
          }.\n` +
          `Error: ${e.message}`,
        e.stack
      );
      throw e;
    }
  }

  async function increaseObservationCardinality(rdOracle, cardinalityNext) {
    try {
      await rdOracle.increaseObservationCardinalityNext(cardinalityNext);
    } catch (e) {
      console.error("Error increasing oracle cardinality:", e);
    }
  }

  async function createPool(logSetup = false) {
    const showLogs = logsOn && logSetup;
    if (showLogs) {
      console.log("constructor args");
      console.log("vault", vault.address);
      console.log("RD", RD.address);
      console.log("QUOTE_PERIOD_FAST", QUOTE_PERIOD_FAST);
      console.log("QUOTE_PERIOD_SLOW", QUOTE_PERIOD_SLOW);
      console.log("stablecoins", stablecoins);
      console.log("MIN_OBSERVATION_DELTA", MIN_OBSERVATION_DELTA);
    }

    const poolName = "RD-USDC-USDT-DAI";
    const poolSymbol = "RD-USDC-USDT-DAI";

    // Normalize addresses and sort
    sortedAddresses = [RDTAddress, DAIAddress, USDCAddress, USDTAddress]
      .map(addr => ethers.utils.getAddress(addr)) // Normalize addresses
      .sort((a, b) => {
        const aBN = ethers.BigNumber.from(a);
        const bBN = ethers.BigNumber.from(b);
        return aBN.lt(bBN) ? -1 : aBN.gt(bBN) ? 1 : 0;
      });

    const addressToConfig = {
      [RDTAddress]: createTruffleTokenConfig(RDTAddress, TokenType.STANDARD),
      [DAIAddress]: createTruffleTokenConfig(DAIAddress, TokenType.STANDARD),
      [USDCAddress]: createTruffleTokenConfig(USDCAddress, TokenType.STANDARD),
      [USDTAddress]: createTruffleTokenConfig(USDTAddress, TokenType.STANDARD)
    };

    const truffleTokenConfigs = sortedAddresses.map(address => addressToConfig[address]);

    const amplificationParameter = DEFAULT_AMP_FACTOR;

    const truffleRoleAccounts = [
      anvilAccount1, // pauseManager
      anvilAccount1, // swapFeeManager
      ZERO_ADDRESS // poolCreator
    ];

    const swapFeePercentage = BASE_MIN_SWAP_FEE; // Defined as 1e12
    const poolHookContract_Address = rdOracle.address; // rdOracle instance must be ready
    const enableDonation = false;
    const disableUnbalancedLiquidity = false;
    const randomBytes = ethers.utils.randomBytes(32);
    const salt = ethers.utils.hexlify(randomBytes);

    if (showLogs) {
      console.log(`Attempting to create pool with factory: ${stablePoolFactory.address}`);
      console.log(`Parameters for create:`);
      console.log(`  Name: ${poolName}`);
      console.log(`  Symbol: ${poolSymbol}`);
      console.log(`  Token Configs: `, truffleTokenConfigs);
      console.log(`  Amplification: ${amplificationParameter.toString()}`);
      console.log(`  Role Accounts: `, truffleRoleAccounts);
      console.log(`  Swap Fee: ${swapFeePercentage.toString()}`);
      console.log(`  Hook Address: ${poolHookContract_Address}`);
      console.log(`  Salt: ${salt}`);
      console.log(`  Sender (from account): ${anvilAccount1}`);
    }

    try {
      const txResponse = await stablePoolFactory.create(
        poolName,
        poolSymbol,
        truffleTokenConfigs,
        amplificationParameter,
        truffleRoleAccounts,
        swapFeePercentage,
        poolHookContract_Address,
        enableDonation,
        disableUnbalancedLiquidity,
        salt
      );

      if (showLogs) {
        console.log("Pool creation transaction sent successfully!");
        console.log("Transaction Hash:", txResponse.tx);
      }

      // Reset for each test run in case a previous run failed to find them
      newPoolAddress = null;
      poolId = null;

      if (txResponse.logs) {
        for (const log of txResponse.logs) {
          if (log.event === "PoolCreated" && log.args && log.args.pool) {
            newPoolAddress = log.args.pool;
            // Calculate poolId: Balancer V3 poolId is often the pool address itself, cast to bytes32.
            poolId = ethers.utils.hexZeroPad(newPoolAddress, 32);

            stablePool = await StablePool.at(newPoolAddress);
            if (showLogs) {
              console.log("New Pool Address via PoolCreated event:", newPoolAddress);
              console.log("Derived Pool ID:", poolId);
            }
            break;
          }
        }
      }

      if (!newPoolAddress) {
        if (showLogs) {
          console.log(
            "PoolCreated event not found or pool address missing in logs. Check contract events."
          );
        }
        // Throw an error if pool isn't created, as tests below depend on it
        throw new Error("Failed to create and identify the new Balancer pool in beforeEach.");
      }
    } catch (error) {
      console.error("Error in beforeEach during pool creation:", error);
      throw error; // Re-throw to fail the test setup if pool creation fails
    }
  }

  async function initializePool(logSetup = false) {
    const showLogs = logsOn && logSetup;

    // Create a mapping of address to decimals
    const addressToDecimals = {
      [RDTAddress]: RD_DECIMALS,
      [DAIAddress]: DAI_DECIMALS,
      [USDCAddress]: USDC_DECIMALS,
      [USDTAddress]: USDT_DECIMALS
    };

    // Map addresses to token contracts
    const addressToToken = {
      [RDTAddress]: RD,
      [DAIAddress]: DAI,
      [USDCAddress]: USDC,
      [USDTAddress]: USDT
    };

    // Create exact amounts in the same order as sorted addresses
    const exactAmountsIn = sortedAddresses.map(address => {
      const decimals = addressToDecimals[address];
      return ethers.utils.parseUnits("1000000", decimals).toString(); // 100 tokens each
    });

    try {
      // Create Permit2 contract instance
      if (showLogs) {
        console.log("Setting ERC20 approvals to Permit2 first...");
      }

      // First, approve Permit2 to spend each token
      const maxApproval = ethers.constants.MaxUint256;
      await RD.approve(PERMIT2_ADDRESS, maxApproval, { from: swapperAccount });
      await DAI.approve(PERMIT2_ADDRESS, maxApproval, { from: swapperAccount });
      await USDC.approve(PERMIT2_ADDRESS, maxApproval, { from: swapperAccount });
      await USDT.approve(PERMIT2_ADDRESS, 0, { from: swapperAccount });
      await USDT.approve(PERMIT2_ADDRESS, maxApproval, { from: swapperAccount });

      if (showLogs) {
        console.log("ERC20 approvals to Permit2 complete. Now setting Permit2 allowances...");
      }

      const permit2Contract = new ethers.Contract(
        PERMIT2_ADDRESS,
        [
          "function approve(address token, address spender, uint160 amount, uint48 expiration) external"
        ],
        ethersSigner
      );

      if (showLogs) {
        console.log("Setting individual Permit2 allowances...");
      }
      // Set individual permits for each token in sorted order
      const expiration = Math.floor(Date.now() / 1000) + 86400; // 24 hours

      for (let i = 0; i < sortedAddresses.length; i++) {
        const tokenAddress = sortedAddresses[i];
        const tokenContract = addressToToken[tokenAddress];
        const amount = exactAmountsIn[i];

        await permit2Contract.approve(tokenAddress, router.address, amount, expiration);

        if (showLogs) {
          console.log(
            `Approved ${amount} for token ${tokenAddress} (${tokenContract.symbol() || "Unknown"})`
          );
        }
      }

      if (showLogs) {
        console.log("Permit2 allowances set, now trying initialize...");
      }

      let initializePoolTx;
      try {
        initializePoolTx = await router.initialize(
          newPoolAddress,
          sortedAddresses,
          exactAmountsIn.map(amount => amount.toString()),
          "0",
          false,
          "0x",
          { from: swapperAccount }
        );
      } catch (e) {
        console.error("Error during pool initialization:", e);
      }

      if (showLogs) {
        console.log("Pool initialized successfully with individual permits!");
        console.log("Transaction hash:", initializePoolTx.tx);
      }
    } catch (e) {
      console.error("Error during pool initialization:", e);
    }
  }

  async function addLiquidity(logSetup = false) {
    const showLogs = logsOn && logSetup;

    // Create a mapping of address to decimals
    const addressToDecimals = {
      [RDTAddress]: RD_DECIMALS,
      [DAIAddress]: DAI_DECIMALS,
      [USDCAddress]: USDC_DECIMALS,
      [USDTAddress]: USDT_DECIMALS
    };

    // Map addresses to token contracts
    const addressToToken = {
      [RDTAddress]: RD,
      [DAIAddress]: DAI,
      [USDCAddress]: USDC,
      [USDTAddress]: USDT
    };

    // Create exact amounts in the same order as sorted addresses
    const exactAmountsIn = sortedAddresses.map(address => {
      const decimals = addressToDecimals[address];
      return ethers.utils.parseUnits("10000", decimals).toString();
    });

    try {
      // Create Permit2 contract instance
      if (showLogs) {
        console.log("Setting ERC20 approvals to Permit2 first...");
      }

      // First, approve Permit2 to spend each token
      const maxApproval = ethers.constants.MaxUint256;
      await RD.approve(PERMIT2_ADDRESS, maxApproval, { from: swapperAccount });
      await DAI.approve(PERMIT2_ADDRESS, maxApproval, { from: swapperAccount });
      await USDC.approve(PERMIT2_ADDRESS, maxApproval, { from: swapperAccount });
      await USDT.approve(PERMIT2_ADDRESS, 0, { from: swapperAccount });
      await USDT.approve(PERMIT2_ADDRESS, maxApproval, { from: swapperAccount });

      if (showLogs) {
        console.log("ERC20 approvals to Permit2 complete. Now setting Permit2 allowances...");
      }

      const permit2Contract = new ethers.Contract(
        PERMIT2_ADDRESS,
        [
          "function approve(address token, address spender, uint160 amount, uint48 expiration) external"
        ],
        ethersSigner
      );

      if (showLogs) {
        console.log("Setting individual Permit2 allowances...");
      }
      // Set individual permits for each token in sorted order
      const expiration = Math.floor(Date.now() / 1000) + 86400; // 24 hours

      for (let i = 0; i < sortedAddresses.length; i++) {
        const tokenAddress = sortedAddresses[i];
        const tokenContract = addressToToken[tokenAddress];
        const amount = exactAmountsIn[i];

        await permit2Contract.approve(tokenAddress, router.address, amount, expiration);

        if (showLogs) {
          console.log(
            `Approved ${amount} for token ${tokenAddress} (${tokenContract.symbol() || "Unknown"})`
          );
        }
      }

      if (showLogs) {
        console.log("Permit2 allowances set, now trying initialize...");
      }

      let addLiquidityTx;
      try {
        addLiquidityTx = await router.addLiquidityUnbalanced(
          newPoolAddress,
          exactAmountsIn.map(amount => amount.toString()),
          "0",
          false,
          "0x",
          { from: swapperAccount }
        );
        if (showLogs) {
          console.log("addLiquidity successfully with individual permits!");
          console.log("Transaction hash:", addLiquidityTx.tx);
        }

        return addLiquidityTx.tx;
      } catch (e) {
        console.error("Error during pool addLiquidity:", e);
      }
    } catch (e) {
      console.error("Error during pool initialization:", e);
    }
  }

  async function removeLiquidity(logSetup = false) {
    const showLogs = logsOn && logSetup;

    // Create a mapping of address to decimals
    const addressToDecimals = {
      [RDTAddress]: RD_DECIMALS,
      [DAIAddress]: DAI_DECIMALS,
      [USDCAddress]: USDC_DECIMALS,
      [USDTAddress]: USDT_DECIMALS
    };

    // Create exact amounts in the same order as sorted addresses
    const exactAmountsOut = sortedAddresses.map(address => {
      const decimals = addressToDecimals[address];
      return ethers.utils.parseUnits("1000", decimals).toString();
    });

    try {
      const bptAmountIn = ethers.utils.parseUnits("100", 18);
      const bptContract = await ERC20.at(newPoolAddress);

      // Approve the Router directly to spend BPTs.
      await bptContract.approve(router.address, bptAmountIn, { from: swapperAccount });

      if (showLogs) {
        console.log(`Approved Router (${router.address}) to spend ${bptAmountIn} BPT.`);
      }

      if (showLogs) {
        console.log(`Approved Router (${router.address}) to spend ${bptAmountIn} BPT via Permit2.`);
      }

      const minAmountsOut = sortedAddresses.map(() => "0");

      let removeLiquidityTx;
      try {
        removeLiquidityTx = await router.removeLiquidityProportional(
          newPoolAddress,
          bptAmountIn.toString(),
          minAmountsOut,
          false,
          "0x",
          { from: swapperAccount }
        );
        if (showLogs) {
          console.log("removeLiquidity successfully with individual permits!");
          console.log("Transaction hash:", removeLiquidityTx.tx);
        }

        return removeLiquidityTx.tx;
      } catch (e) {
        console.error("Error during pool removeLiquidity:", e);
      }
    } catch (e) {
      console.error("Error during pool initialization:", e);
    }
  }

  async function createOracle(logSetup = false) {
    const showLogs = logsOn && logSetup;

    if (showLogs) {
      console.log("Creating oracle...");
      console.log("Vault:", vault.address);
      console.log("RDTAddress:", RDTAddress);
      console.log("QUOTE_PERIOD_FAST:", QUOTE_PERIOD_FAST);
      console.log("QUOTE_PERIOD_SLOW:", QUOTE_PERIOD_SLOW);
      console.log("stablecoins:", stablecoins);
      console.log("MIN_OBSERVATION_DELTA:", MIN_OBSERVATION_DELTA);
    }

    try {
      // rdOracle = await RDOracle.new(
      //   vault.address,
      //   RDTAddress,
      //   QUOTE_PERIOD_FAST,
      //   QUOTE_PERIOD_SLOW,
      //   stablecoins,
      //   MIN_OBSERVATION_DELTA
      // );
      rdOracle = await RDOracleTestHelper.new(
        vault.address,
        RDTAddress,
        QUOTE_PERIOD_FAST,
        QUOTE_PERIOD_SLOW,
        stablecoins,
        MIN_OBSERVATION_DELTA
      );
      if (showLogs) {
        console.log("Oracle created successfully:", rdOracle.address);
      }
    } catch (e) {
      console.error("Error during oracle creation:", e);
    }
  }

  function getRandomTokenPair() {
    const tokens = [
      { token: RD, symbol: "RD", decimals: RD_DECIMALS },
      { token: USDC, symbol: "USDC", decimals: USDC_DECIMALS },
      { token: USDT, symbol: "USDT", decimals: USDT_DECIMALS },
      { token: DAI, symbol: "DAI", decimals: DAI_DECIMALS }
    ];

    // Randomly select two different tokens
    const tokenInIndex = Math.floor(Math.random() * tokens.length);
    let tokenOutIndex = Math.floor(Math.random() * (tokens.length - 1));
    if (tokenOutIndex >= tokenInIndex) {
      tokenOutIndex++; // Skip the tokenIn to avoid same token
    }

    return {
      tokenIn: tokens[tokenInIndex],
      tokenOut: tokens[tokenOutIndex]
    };
  }

  function getFixedTokenPair(index) {
    const pairs = [
      {
        tokenIn: { token: RD, symbol: "RD", decimals: RD_DECIMALS },
        tokenOut: { token: USDC, symbol: "USDC", decimals: USDC_DECIMALS }
      },
      {
        tokenIn: { token: USDC, symbol: "USDC", decimals: USDC_DECIMALS },
        tokenOut: { token: RD, symbol: "RD", decimals: RD_DECIMALS }
      },
      {
        tokenIn: { token: RD, symbol: "RD", decimals: RD_DECIMALS },
        tokenOut: { token: DAI, symbol: "DAI", decimals: DAI_DECIMALS }
      },
      {
        tokenIn: { token: DAI, symbol: "DAI", decimals: DAI_DECIMALS },
        tokenOut: { token: RD, symbol: "RD", decimals: RD_DECIMALS }
      },
      {
        tokenIn: { token: USDC, symbol: "USDC", decimals: USDC_DECIMALS },
        tokenOut: { token: USDT, symbol: "USDT", decimals: USDT_DECIMALS }
      },
      {
        tokenIn: { token: USDT, symbol: "USDT", decimals: USDT_DECIMALS },
        tokenOut: { token: DAI, symbol: "DAI", decimals: DAI_DECIMALS }
      }
    ];

    // Cycle through the pairs
    return pairs[index % pairs.length];
  }

  async function createMockTokens(logSetup = false) {
    const showLogs = logsOn && logSetup;

    if (showLogs) {
      console.log("Creating mock tokens...");
    }

    try {
      // Create mock tokens with appropriate decimals
      mockRD = await MockERC20.new("Mock RD Token", "RD", RD_DECIMALS);
      mockUSDC = await MockERC20.new("Mock USDC", "USDC", USDC_DECIMALS);
      mockUSDT = await MockERC20.new("Mock USDT", "USDT", USDT_DECIMALS);
      mockDAI = await MockERC20.new("Mock DAI", "DAI", DAI_DECIMALS);

      // Store addresses
      RDTAddress = mockRD.address;
      USDCAddress = mockUSDC.address;
      USDTAddress = mockUSDT.address;
      DAIAddress = mockDAI.address;

      stablecoins = [USDCAddress, USDTAddress, DAIAddress];

      if (showLogs) {
        console.log("Mock tokens created:");
        console.log("RD:", RDTAddress);
        console.log("USDC:", USDCAddress);
        console.log("USDT:", USDTAddress);
        console.log("DAI:", DAIAddress);
      }

      // Mint tokens to the swapper account
      const mintAmount = ethers.utils.parseUnits("10000000", 18); // 10M tokens each

      await mockRD.mint(anvilAccount1, mintAmount);
      await mockUSDC.mint(anvilAccount1, ethers.utils.parseUnits("10000000", USDC_DECIMALS));
      await mockUSDT.mint(anvilAccount1, ethers.utils.parseUnits("10000000", USDT_DECIMALS));
      await mockDAI.mint(anvilAccount1, mintAmount);

      if (showLogs) {
        console.log("Minted 10M tokens to swapper account");
      }

      // Update the global token variables
      RD = mockRD;
      USDC = mockUSDC;
      USDT = mockUSDT;
      DAI = mockDAI;

      if (showLogs) {
        console.log("Mock tokens setup complete");
      }
    } catch (e) {
      console.error("Failed to create mock tokens:", e);
      throw e;
    }
  }

  async function buildObservationHistoryFast(logSetup = false) {
    const showLogs = logsOn && logSetup;

    // Just 5 swaps to establish basic history
    const swapAmounts = [10000, 20000, 15000, 30000, 25000];
    const timeInterval = 120; // Fixed interval

    for (let i = 0; i < swapAmounts.length; i++) {
      try {
        const { tokenIn, tokenOut } = getRandomTokenPair();

        // Single time increase
        await time.increase(MIN_OBSERVATION_DELTA + timeInterval);

        await executeSwap({
          signer: ethersSigner,
          newPoolAddress,
          _amountIn: swapAmounts[i].toString(),
          _minAmountOut: "1",
          tokenIn: tokenIn.token,
          tokenOut: tokenOut.token,
          tokenInDecimals: tokenIn.decimals,
          tokenOutDecimals: tokenOut.decimals
        });

        if (showLogs) {
          console.log(`Swap ${i + 1} completed`);
        }
      } catch (e) {
        console.error("Error during swap:", e);
        throw e;
      }
    }
  }

  async function buildObservationHistorySmall(logSetup = false) {
    const showLogs = logsOn && logSetup;
    const swapAmounts = [10000, 20000, 15000, 30000, 25000, 10000, 20000, 15000, 30000, 25000];
    const timeIntervals = [120, 180, 90, 240, 150, 120, 180, 90, 240, 150];

    for (let i = 0; i < swapAmounts.length; i++) {
      try {
        const { tokenIn, tokenOut } = getFixedTokenPair(i);

        if (showLogs) {
          const tokenInBalance = await tokenIn.token.balanceOf(anvilAccount1);
          console.log(`${tokenIn.symbol} balance before swap:`, tokenInBalance.toString());
          console.log("--------------------------------");
          console.log(`Swap ${i + 1}: ${tokenIn.symbol} -> ${tokenOut.symbol}`);
        }

        // await time.increase(MIN_OBSERVATION_DELTA + 1);
        await time.increase(timeIntervals[i]);
        // Perform swap with random tokens
        await executeSwap({
          signer: ethersSigner,
          newPoolAddress,
          _amountIn: swapAmounts[i].toString(),
          _minAmountOut: "1",
          tokenIn: tokenIn.token,
          tokenOut: tokenOut.token,
          tokenInDecimals: tokenIn.decimals,
          tokenOutDecimals: tokenOut.decimals
        });

        if (showLogs) {
          const postSwapOracleState = await rdOracle.oracleState();
          console.log(`postSwapOracleState: ${i + 1}`);
          logOracleState(postSwapOracleState);
        }

        // Wait additional time to create time separation
        if (i < swapAmounts.length - 1) {
          await time.increase(timeIntervals[i]);
        }
      } catch (e) {
        console.error("Error during swap:", e);
        throw e;
      }
    }
  }

  async function executeLargeSwaps() {
    await time.increase(200);
    await executeSwap({
      signer: ethersSigner,
      newPoolAddress,
      _amountIn: "500000", // Much larger swap
      _minAmountOut: "1",
      tokenIn: RD,
      tokenOut: USDC,
      tokenInDecimals: RD_DECIMALS,
      tokenOutDecimals: USDC_DECIMALS
    });

    // Wait more time and add another swap
    await time.increase(300);
    await executeSwap({
      signer: ethersSigner,
      newPoolAddress,
      _amountIn: "200000",
      _minAmountOut: "1",
      tokenIn: USDC,
      tokenOut: RD,
      tokenInDecimals: USDC_DECIMALS,
      tokenOutDecimals: RD_DECIMALS
    });
  }

  before.skip(async () => {
    console.log("\n=== STARTING NEW TEST WITH MOCK TOKENS ===");

    // Step 1: Create mock tokens
    console.log("Step 1: Creating mock tokens...");
    await createMockTokens(false);

    console.log("Step 2: Setting up Balancer contracts...");
    await setupBalancerContracts(false);

    // Step 3: Create the oracle with mock token addresses
    console.log("Step 3: Creating oracle...");
    await createOracle(false);

    // Step 4: Create the pool
    console.log("Step 4: Creating pool...");
    await createPool(false);

    // Step 5: Initialize the pool
    console.log("Step 5: Initializing pool...");
    await initializePool(false);

    // Step 6: Increase observation cardinality
    console.log("Step 6: Increasing observation cardinality...");
    await increaseObservationCardinality(rdOracle, 100);

    // Step 7: Build observation history
    console.log("Step 7: Building observation history...");
    await buildObservationHistorySmall(true);

    // Step 9: Execute large swaps
    console.log("Step 9: Executing large swaps...");
    await executeLargeSwaps();
  });

  describe.skip("RDOracle Initialization", () => {
    it("should initialize with correct parameters", async () => {
      // Check vault address
      expect(await rdOracle.vault()).to.equal(vault.address);
      // Check RD token address
      expect(await rdOracle.rdToken()).to.equal(RDTAddress);
      // Check quote periods
      expect(await rdOracle.quotePeriodFast()).to.be.bignumber.equal(new BN(QUOTE_PERIOD_FAST));
      expect(await rdOracle.quotePeriodSlow()).to.be.bignumber.equal(new BN(QUOTE_PERIOD_SLOW));
      // Check minimum observation delta
      expect(await rdOracle.minObservationDelta()).to.be.bignumber.equal(
        new BN(MIN_OBSERVATION_DELTA)
      );
      // Check stablecoin basket
      const basket = await rdOracle.stablecoinBasket();
      expect(basket).to.have.lengthOf(3);
      expect(basket[0]).to.equal(USDC.address);
      expect(basket[1]).to.equal(USDT.address);
      expect(basket[2]).to.equal(DAI.address);
    });

    it("should revert if fast period >= slow period", async () => {
      await assertRevert(
        RDOracle.new(
          vault.address,
          RDTAddress,
          QUOTE_PERIOD_SLOW, // Using slow period as fast period
          QUOTE_PERIOD_SLOW,
          stablecoins,
          MIN_OBSERVATION_DELTA
        ),
        "Oracle_PeriodMismatch()"
      );

      // Try to deploy with fast period greater than slow period
      await assertRevert(
        RDOracle.new(
          vault.address,
          RDTAddress,
          QUOTE_PERIOD_SLOW + 100, // Fast period > slow period
          QUOTE_PERIOD_SLOW,
          stablecoins,
          MIN_OBSERVATION_DELTA
        ),
        "Oracle_PeriodMismatch()"
      );
    });

    it("should initialize oracle state with price of 1 RD/USD", async () => {
      // Create a fresh oracle without any pool operations
      const freshOracle = await RDOracle.new(
        vault.address,
        RDTAddress,
        QUOTE_PERIOD_FAST,
        QUOTE_PERIOD_SLOW,
        stablecoins,
        MIN_OBSERVATION_DELTA
      );

      const oracleState = await freshOracle.oracleState();
      const expectedSqrtPriceX96 = new BN("2").pow(new BN("96"));
      expect(oracleState.sqrtPriceX96).to.be.bignumber.equal(expectedSqrtPriceX96);
    });

    it("should initialize oracle with proper symbol", async () => {
      expect(await rdOracle.symbol()).to.equal("RD / USD");
    });

    it("should set correct stablecoin basket indices", async () => {
      const indices = await rdOracle.stablecoinBasketIndices();
      expect(indices).to.have.lengthOf(3);

      // Calculate expected indices based on sorted addresses
      const originalStablecoins = [USDCAddress, USDTAddress, DAIAddress];
      const expectedIndices = originalStablecoins.map(stablecoin => {
        return sortedAddresses.indexOf(stablecoin);
      });

      // Verify indices are set correctly (they should match the order in the sorted addresses)
      expect(indices[0]).to.be.bignumber.equal(new BN(expectedIndices[0]));
      expect(indices[1]).to.be.bignumber.equal(new BN(expectedIndices[1]));
      expect(indices[2]).to.be.bignumber.equal(new BN(expectedIndices[2]));
    });

    it("should revert if vault address is zero", async () => {
      await assertRevert(
        RDOracle.new(
          ZERO_ADDRESS,
          RD.address,
          QUOTE_PERIOD_FAST,
          QUOTE_PERIOD_SLOW,
          stablecoins,
          MIN_OBSERVATION_DELTA
        ),
        "Oracle_VaultNotSet()"
      );
    });

    it("should revert if RD token address is zero", async () => {
      await assertRevert(
        RDOracle.new(
          vault.address,
          ZERO_ADDRESS,
          QUOTE_PERIOD_FAST,
          QUOTE_PERIOD_SLOW,
          stablecoins,
          MIN_OBSERVATION_DELTA
        ),
        "Oracle_RDTokenNotSet()"
      );
    });

    it("should revert if stablecoins array is empty", async () => {
      await assertRevert(
        RDOracle.new(
          vault.address,
          RD.address,
          QUOTE_PERIOD_FAST,
          QUOTE_PERIOD_SLOW,
          [], // Empty stablecoins array
          MIN_OBSERVATION_DELTA
        ),
        "Oracle_StablecoinBasketEmpty()"
      );
    });

    it("should revert if stablecoins array contains a zero address", async () => {
      const stablecoinsWithZero = [USDC.address, ZERO_ADDRESS, DAI.address];
      await assertRevert(
        RDOracle.new(
          vault.address,
          RD.address,
          QUOTE_PERIOD_FAST,
          QUOTE_PERIOD_SLOW,
          stablecoinsWithZero,
          MIN_OBSERVATION_DELTA
        ),
        "Oracle_StablecoinBasketZeroAddress()"
      );
    });
  });

  describe.skip("RDOracle cardinality", async () => {
    it("should increase cardinality", async () => {
      const beforeState = await rdOracle.oracleState();
      expect(beforeState.observationCardinalityNext).to.be.bignumber.equal(new BN(100));
      await increaseObservationCardinality(rdOracle, 125);
      const afterState = await rdOracle.oracleState();
      expect(afterState.observationCardinalityNext).to.be.bignumber.equal(new BN(125));
    });
  });

  describe.skip("Balancer Pool Hook Functionality (afterSwap)", async () => {
    it("should call the oracle hook onAfterSwap handler", async () => {
      try {
        const swapTx = await executeSwap({
          signer: ethersSigner,
          newPoolAddress,
          _amountIn: "11",
          _minAmountOut: "1",
          tokenIn: RD,
          tokenOut: USDC,
          tokenInDecimals: RD_DECIMALS,
          tokenOutDecimals: USDC_DECIMALS
        });
        // Get transaction receipt to see if the hook was called and check if the event is correct
        const receipt = await web3.eth.getTransactionReceipt(swapTx.tx);
        // Check if there are any events from the oracle
        const oracleEvents = receipt.logs.filter(
          log => log.address.toLowerCase() === rdOracle.address.toLowerCase()
        );
        expect(oracleEvents.length).to.be.equal(1);
        const eventTopic = oracleEvents[0].topics[0];
        expect(eventTopic).to.be.equal(
          web3.utils.sha3("OracleHookCalled(address,bool,uint32,uint32)")
        );
      } catch (e) {
        console.error("Error during swap:", e);
        throw e;
      }
    });

    it("should not record an observation if minObservationDelta is not met", async () => {
      const lastUpdateTime = await rdOracle.getLastUpdateTime();
      const minObservationDelta = await rdOracle.minObservationDelta();
      const currentBlockTime = (await time.latest()).toNumber();
      const timeSinceLastUpdate = currentBlockTime - lastUpdateTime.toNumber();
      const shouldUpdate = timeSinceLastUpdate >= minObservationDelta.toNumber();
      expect(shouldUpdate).to.be.equal(false);
      const oracleStateBefore = await rdOracle.oracleState();
      expect(oracleStateBefore.observationIndex.toNumber()).to.be.equal(12);

      try {
        await executeSwap({
          signer: ethersSigner,
          newPoolAddress,
          _amountIn: "11",
          _minAmountOut: "1",
          tokenIn: RD,
          tokenOut: USDC,
          tokenInDecimals: RD_DECIMALS,
          tokenOutDecimals: USDC_DECIMALS
        });
      } catch (e) {
        console.error("Error during swap:", e);
        throw e;
      }

      const oracleStateAfter = await rdOracle.oracleState();
      expect(oracleStateAfter.observationIndex.toNumber()).to.be.equal(12);
    });

    it("should record an observation if minObservationDelta is met", async () => {
      const lastUpdateTime = await rdOracle.getLastUpdateTime();
      const minObservationDelta = await rdOracle.minObservationDelta();
      await time.increase(minObservationDelta.toNumber() + 1);
      const currentBlockTime = (await time.latest()).toNumber();
      const timeSinceLastUpdate = currentBlockTime - lastUpdateTime.toNumber();
      const shouldUpdate = timeSinceLastUpdate >= minObservationDelta.toNumber();
      expect(shouldUpdate).to.be.equal(true);
      const oracleStateBefore = await rdOracle.oracleState();
      expect(oracleStateBefore.observationIndex.toNumber()).to.be.equal(12);
      try {
        await executeSwap({
          signer: ethersSigner,
          newPoolAddress,
          _amountIn: "11",
          _minAmountOut: "1",
          tokenIn: RD,
          tokenOut: USDC,
          tokenInDecimals: RD_DECIMALS,
          tokenOutDecimals: USDC_DECIMALS
        });
      } catch (e) {
        console.error("Error during swap:", e);
        throw e;
      }
      const oracleStateAfter = await rdOracle.oracleState();
      expect(oracleStateAfter.observationIndex.toNumber()).to.be.equal(13);
    });
  });

  describe.skip("Balancer Pool Hook Functionality (afterAddLiquidity)", async () => {
    it("should call the oracle hook onAfterAddLiquidity handler", async () => {
      try {
        const txHash = await addLiquidity();
        // Get transaction receipt to see if the hook was called and check if the event is correct
        const receipt = await web3.eth.getTransactionReceipt(txHash);
        // Check if there are any events from the oracle
        const oracleEvents = receipt.logs.filter(
          log => log.address.toLowerCase() === rdOracle.address.toLowerCase()
        );
        expect(oracleEvents.length).to.be.equal(1);
        const eventTopic = oracleEvents[0].topics[0];
        expect(eventTopic).to.be.equal(
          web3.utils.sha3("OracleHookCalled(address,bool,uint32,uint32)")
        );
      } catch (e) {
        console.error("Error during addLiquidity:", e);
        throw e;
      }
    });
  });

  describe.skip("Balancer Pool Hook Functionality (afterRemoveLiquidity)", async () => {
    it("should call the oracle hook onAfterRemoveLiquidity handler", async () => {
      try {
        const txHash = await removeLiquidity();
        // Get transaction receipt to see if the hook was called and check if the event is correct
        const receipt = await web3.eth.getTransactionReceipt(txHash);
        // Check if there are any events from the oracle
        const oracleEvents = receipt.logs.filter(
          log => log.address.toLowerCase() === rdOracle.address.toLowerCase()
        );
        expect(oracleEvents.length).to.be.equal(1);
        const eventTopic = oracleEvents[0].topics[0];
        expect(eventTopic).to.be.equal(
          web3.utils.sha3("OracleHookCalled(address,bool,uint32,uint32)")
        );
      } catch (e) {
        console.error("Error during removeLiquidity:", e);
        throw e;
      }
    });
  });

  describe.skip("Price Reading Functions", () => {
    it("should build observation history through multiple swaps", async () => {
      const finalOracleState = await rdOracle.oracleState();
      expect(finalOracleState.observationIndex.toNumber()).to.be.equal(13);
    });

    it("should read fast price correctly", async () => {
      const fastPrice = await rdOracle.readFast();
      expect(fastPrice).to.be.bignumber.gt(new BN(0));

      // Use a range to account for test non-determinism
      const expectedFastPrice = new BN("1008100000000000000"); // Central value
      const tolerance = new BN("1000000000000000"); // 0.001 tolerance
      const lowerBound = expectedFastPrice.sub(tolerance);
      const upperBound = expectedFastPrice.add(tolerance);

      expect(fastPrice).to.be.bignumber.gte(lowerBound);
      expect(fastPrice).to.be.bignumber.lte(upperBound);
    });

    it("should read slow price correctly", async () => {
      const slowPrice = await rdOracle.readSlow();
      expect(slowPrice.toString()).to.be.equal("1002904063656376288");
      expect(slowPrice).to.be.bignumber.gt(new BN(0));
      expect(slowPrice).to.be.bignumber.equal(new BN("1002904063656376288"));
    });

    it("should read both fast and slow prices", async () => {
      const { _fastValue, _slowValue } = await rdOracle.readFastSlow();

      const expectedFastPrice = new BN("1008100000000000000"); // Central value
      const tolerance = new BN("1000000000000000"); // 0.001 tolerance
      const lowerBound = expectedFastPrice.sub(tolerance);
      const upperBound = expectedFastPrice.add(tolerance);

      expect(_fastValue).to.be.bignumber.gte(lowerBound);
      expect(_fastValue).to.be.bignumber.lte(upperBound);

      expect(_slowValue).to.be.bignumber.equal(new BN("1002904063656376288"));
      expect(_fastValue).to.be.bignumber.gt(new BN(0));
      expect(_slowValue).to.be.bignumber.gt(new BN(0));
    });
  });

  describe.skip("Price Calculation Functions", () => {
    it("should get fast result with validity", async () => {
      const { _result, _validity } = await rdOracle.getFastResultWithValidity();
      expect(_result).to.be.bignumber.gt(new BN(0));
      expect(_validity).to.be.true;

      // Use a range to account for test non-determinism
      const expectedFastPrice = new BN("1008100000000000000"); // Central value
      const tolerance = new BN("1000000000000000"); // 0.001 tolerance
      const lowerBound = expectedFastPrice.sub(tolerance);
      const upperBound = expectedFastPrice.add(tolerance);

      expect(_result).to.be.bignumber.gte(lowerBound);
      expect(_result).to.be.bignumber.lte(upperBound);
    });

    it("should get slow result with validity", async () => {
      const { _result, _validity } = await rdOracle.getSlowResultWithValidity();
      expect(_result).to.be.bignumber.gt(new BN(0));
      expect(_result).to.be.bignumber.equal(new BN("1002904063656376288"));
      expect(_validity).to.be.true;
    });

    it("should get both fast and slow results with validity", async () => {
      const { _fastResult, _fastValidity, _slowResult, _slowValidity } =
        await rdOracle.getFastSlowResultWithValidity();
      expect(_fastResult).to.be.bignumber.gt(new BN(0));
      expect(_slowResult).to.be.bignumber.gt(new BN(0));

      const expectedFastPrice = new BN("1008100000000000000"); // Central value
      const tolerance = new BN("1000000000000000"); // 0.001 tolerance
      const lowerBound = expectedFastPrice.sub(tolerance);
      const upperBound = expectedFastPrice.add(tolerance);

      expect(_fastResult).to.be.bignumber.gte(lowerBound);
      expect(_fastResult).to.be.bignumber.lte(upperBound);

      expect(_slowResult).to.be.bignumber.equal(new BN("1002904063656376288"));
      expect(_fastValidity).to.be.true;
      expect(_slowValidity).to.be.true;
    });
  });

  describe.skip("Oracle Observation Management", () => {
    it("should observe price data correctly", async () => {
      // Test observe() function
      const { tickCumulatives, secondsPerLiquidityCumulativeX128s } = await rdOracle.observe([
        300, 60
      ]);
      expect(tickCumulatives).to.have.lengthOf(2);
      expect(secondsPerLiquidityCumulativeX128s).to.have.lengthOf(2);
    });

    it("should increase observation cardinality", async () => {
      // Test increaseObservationCardinalityNext()
      const beforeState = await rdOracle.oracleState();
      expect(beforeState.observationCardinalityNext).to.be.bignumber.equal(new BN(125));
      await increaseObservationCardinality(rdOracle, 150);
      const afterState = await rdOracle.oracleState();
      expect(afterState.observationCardinalityNext).to.be.bignumber.equal(new BN(150));
    });

    // NOTE: This test works but takes a long time to run
    // xit("should handle observation cardinality growth correctly", async () => {
    //   // Test that cardinality grows properly and doesn't exceed maximum
    //   let step = 1000;
    //   const maxCardinality = 65535;
    //   while (step < maxCardinality) {
    //     await rdOracle.increaseObservationCardinalityNext(step);
    //     console.log(`Increased cardinality to ${step}`);
    //     step += 1000;
    //   }
    //   const state = await rdOracle.oracleState();
    //   expect(state.observationCardinalityNext).to.be.bignumber.lte(new BN(maxCardinality));
    // });
  });

  describe.skip("Price Update Logic", () => {
    before(async () => {
      // Create test helper instance
      rdOracleTestHelper = await RDOracleTestHelper.new(
        vault.address,
        RDTAddress,
        QUOTE_PERIOD_FAST,
        QUOTE_PERIOD_SLOW,
        stablecoins,
        MIN_OBSERVATION_DELTA
      );
    });

    it("should update oracle state when price changes", async () => {
      // Test that oracle state updates when price changes significantly
      const initialState = await rdOracle.oracleState();
      await executeLargeSwaps();
      const finalState = await rdOracle.oracleState();
      expect(finalState.observationIndex).to.be.bignumber.gt(initialState.observationIndex);
    });

    it("should update synthetic RD price via test function and emit OraclePriceUpdated event", async () => {
      const oracleStateBefore = await rdOracle.oracleState();
      expect(oracleStateBefore.observationIndex.toNumber()).to.be.equal(15);

      const { lastBalancesLiveScaled18 } = await iVault.getPoolTokenInfo(newPoolAddress);

      const updateTx = await rdOracle.testUpdateSyntheticRDPrice(lastBalancesLiveScaled18);

      const receipt = await web3.eth.getTransactionReceipt(updateTx.tx);

      // Filter oracle events
      const oracleEvents = receipt.logs.filter(
        log => log.address.toLowerCase() === rdOracle.address.toLowerCase()
      );

      if (oracleEvents.length === 0) {
        console.log("No oracle events found. All events:");
        receipt.logs.forEach((log, i) => {
          console.log(`Event ${i}: ${log.address} - ${log.topics[0]}`);
        });
      }

      expect(oracleEvents.length).to.be.equal(1);

      const priceEventSig = web3.utils.sha3(
        "OraclePriceUpdated(int24,int24,uint160,uint160,uint16)"
      );

      const priceEvent = oracleEvents.find(event => event.topics[0] === priceEventSig);
      expect(priceEvent).to.not.be.undefined;

      const oracleStateAfter = await rdOracle.oracleState();

      expect(oracleStateAfter.observationIndex.toNumber()).to.be.equal(16);
    });

    it("should emit OracleHookCalled and OraclePriceUpdated events when price changes", async () => {
      // Test that OraclePriceUpdated event is emitted when price changes
      const initialState = await rdOracle.oracleState();

      await time.increase(MIN_OBSERVATION_DELTA + 10); // Add buffer

      const swapTx = await executeSwap({
        signer: ethersSigner,
        newPoolAddress,
        _amountIn: "50000",
        _minAmountOut: "1",
        tokenIn: RD,
        tokenOut: USDC,
        tokenInDecimals: RD_DECIMALS,
        tokenOutDecimals: USDC_DECIMALS
      });

      const receipt = await web3.eth.getTransactionReceipt(swapTx.tx);

      // Filter oracle events
      const oracleEvents = receipt.logs.filter(
        log => log.address.toLowerCase() === rdOracle.address.toLowerCase()
      );

      if (oracleEvents.length === 0) {
        console.log("No oracle events found. All events:");
        receipt.logs.forEach((log, i) => {
          console.log(`Event ${i}: ${log.address} - ${log.topics[0]}`);
        });
      }

      const hookEventSig = web3.utils.sha3("OracleHookCalled(address,bool,uint32,uint32)");
      const priceEventSig = web3.utils.sha3(
        "OraclePriceUpdated(int24,int24,uint160,uint160,uint16)"
      );

      // Find and verify events
      const hookEvent = oracleEvents.find(event => event.topics[0] === hookEventSig);
      const priceEvent = oracleEvents.find(event => event.topics[0] === priceEventSig);

      // Basic assertions
      expect(oracleEvents.length).to.equal(2);
      expect(hookEvent).to.not.be.undefined;
      expect(priceEvent).to.not.be.undefined;
      // Check that observation index actually changed
      const finalState = await rdOracle.oracleState();
      expect(finalState.observationIndex).to.be.bignumber.gt(initialState.observationIndex);
    });
  });

  describe.skip("Mathematical Functions", () => {
    it("should calculate median correctly for 3 elements", async () => {
      // Test with 3 elements (odd)
      const oddArray = [
        ethers.utils.parseUnits("1.0", 18),
        ethers.utils.parseUnits("3.0", 18),
        ethers.utils.parseUnits("2.0", 18)
      ];
      // const medianOdd = await rdOracleTestHelper.testCalculateMedian(oddArray);
      const medianOdd = await rdOracle.testCalculateMedian(oddArray);

      // Should return 2.0 (middle element after sorting: [1.0, 2.0, 3.0])
      expect(medianOdd).to.be.bignumber.equal(new BN("2000000000000000000"));
    });

    it("should handle duplicate values correctly", async () => {
      // Test with duplicates in odd array
      const duplicateOddArray = [
        ethers.utils.parseUnits("2.0", 18),
        ethers.utils.parseUnits("1.0", 18),
        ethers.utils.parseUnits("2.0", 18)
      ];
      // const medianDuplicateOdd = await rdOracleTestHelper.testCalculateMedian(duplicateOddArray);
      const medianDuplicateOdd = await rdOracle.testCalculateMedian(duplicateOddArray);
      // Should return 2.0 (middle element after sorting: [1.0, 2.0, 2.0, 2.0, 3.0])
      expect(medianDuplicateOdd).to.be.bignumber.equal(new BN("2000000000000000000"));

      // Test with duplicates in even array
      const duplicateEvenArray = [
        ethers.utils.parseUnits("2.0", 18),
        ethers.utils.parseUnits("1.0", 18),
        ethers.utils.parseUnits("2.0", 18),
        ethers.utils.parseUnits("3.0", 18)
      ];
      // const medianDuplicateEven = await rdOracleTestHelper.testCalculateMedian(duplicateEvenArray);
      const medianDuplicateEven = await rdOracle.testCalculateMedian(duplicateEvenArray);
      // Should return 2.0 (lower of the two middle elements after sorting: [1.0, 2.0, 2.0, 3.0])
      expect(medianDuplicateEven).to.be.bignumber.equal(new BN("2000000000000000000"));
    });

    it("should handle extreme values correctly", async () => {
      // Test with very large and very small values
      const extremeArray = [
        ethers.utils.parseUnits("0.000001", 18), // Very small
        ethers.utils.parseUnits("1000000", 18), // Very large
        ethers.utils.parseUnits("1.0", 18) // Normal value
      ];
      // const medianExtreme = await rdOracleTestHelper.testCalculateMedian(extremeArray);
      const medianExtreme = await rdOracle.testCalculateMedian(extremeArray);
      // Should return 1.0 (middle element after sorting)
      expect(medianExtreme).to.be.bignumber.equal(new BN("1000000000000000000"));
    });

    it("should handle realistic price data scenarios", async () => {
      // Test with realistic stablecoin price data (slightly different from $1.00)
      const realisticPrices = [
        ethers.utils.parseUnits("0.9998", 18), // USDC slightly under $1
        ethers.utils.parseUnits("1.0001", 18), // USDT slightly over $1
        ethers.utils.parseUnits("0.9999", 18) // DAI slightly under $1
      ];
      // const medianRealistic = await rdOracleTestHelper.testCalculateMedian(realisticPrices);
      const medianRealistic = await rdOracle.testCalculateMedian(realisticPrices);
      // Should return 0.9999 (middle element after sorting: [0.9998, 0.9999, 1.0001])
      expect(medianRealistic).to.be.bignumber.equal(new BN("999900000000000000"));
    });

    it("should convert price to sqrtPriceX96 correctly", async () => {
      // Test price = 1.0 WAD
      const price1 = ethers.utils.parseUnits("1.0", 18);
      // const sqrtPriceX96_1 = await rdOracleTestHelper.testConvertPriceToSqrtPriceX96(price1);
      const sqrtPriceX96_1 = await rdOracle.testConvertPriceToSqrtPriceX96(price1);
      const expectedSqrtPriceX96_1 = new BN("2").pow(new BN("96")); // 2^96
      expect(sqrtPriceX96_1).to.be.bignumber.equal(expectedSqrtPriceX96_1);

      // Test price = 4.0 WAD (sqrt should be 2.0 * 2^96)
      const price4 = ethers.utils.parseUnits("4.0", 18);
      // const sqrtPriceX96_4 = await rdOracleTestHelper.testConvertPriceToSqrtPriceX96(price4);
      const sqrtPriceX96_4 = await rdOracle.testConvertPriceToSqrtPriceX96(price4);
      const expectedSqrtPriceX96_4 = new BN("2").pow(new BN("96")).mul(new BN("2")); // 2 * 2^96
      expect(sqrtPriceX96_4).to.be.bignumber.equal(expectedSqrtPriceX96_4);

      // Test price = 0.25 WAD (sqrt should be 0.5 * 2^96)
      const price025 = ethers.utils.parseUnits("0.25", 18);
      // const sqrtPriceX96_025 = await rdOracleTestHelper.testConvertPriceToSqrtPriceX96(price025);
      const sqrtPriceX96_025 = await rdOracle.testConvertPriceToSqrtPriceX96(price025);
      const expectedSqrtPriceX96_025 = new BN("2").pow(new BN("96")).div(new BN("2")); // 0.5 * 2^96
      expect(sqrtPriceX96_025).to.be.bignumber.equal(expectedSqrtPriceX96_025);
    });

    it("should convert sqrtPriceX96 to price correctly", async () => {
      // Test sqrtPriceX96 = 2^96 (should convert back to price = 1.0 WAD)
      const sqrtPriceX96_1 = new BN("2").pow(new BN("96"));
      // const price1 = await rdOracleTestHelper.testConvertSqrtPriceX96ToPrice(sqrtPriceX96_1);
      const price1 = await rdOracle.testConvertSqrtPriceX96ToPrice(sqrtPriceX96_1);
      const expectedPrice1 = "1000000000000000000";
      expect(price1).to.be.bignumber.equal(expectedPrice1);

      // Test sqrtPriceX96 = 2 * 2^96 (should convert to price = 4.0 WAD)
      const sqrtPriceX96_4 = new BN("2").pow(new BN("96")).mul(new BN("2"));
      // const price4 = await rdOracleTestHelper.testConvertSqrtPriceX96ToPrice(sqrtPriceX96_4);
      const price4 = await rdOracle.testConvertSqrtPriceX96ToPrice(sqrtPriceX96_4);
      const expectedPrice4 = "4000000000000000000";
      expect(price4).to.be.bignumber.equal(expectedPrice4);
    });

    it("should calculate partial derivative correctly", async () => {
      // Use realistic parameters for a 4-token pool (RD, USDC, USDT, DAI)
      const tokenBalance = ethers.utils.parseUnits("1000000", 18); // 1M tokens
      const totalTokens = 4;
      const ampValue = 1000; // Typical amplification value
      const ampCoefficient = new BN(totalTokens ** totalTokens).mul(new BN(ampValue)); // n^n * A

      // Realistic values for a balanced 4-token pool
      const balancesSum = ethers.utils.parseUnits("4000000", 18); // 4M total (1M each token)
      const poolInvariant = ethers.utils.parseUnits("4000000", 18); // ~4M invariant
      const ampPrecision = new BN("1000"); // Standard Balancer amp precision

      // const partialDerivative = await rdOracleTestHelper.testCalculatePartialDerivative(
      //   tokenBalance,
      //   ampCoefficient,
      //   poolInvariant,
      //   balancesSum,
      //   ampPrecision
      // );

      const partialDerivative = await rdOracle.testCalculatePartialDerivative(
        tokenBalance,
        ampCoefficient,
        poolInvariant,
        balancesSum,
        ampPrecision
      );

      // The partial derivative should be positive and reasonable for StableSwap
      expect(partialDerivative).to.be.bignumber.gt(new BN("0"));

      // For these parameters, expect around 256-260 (in WAD format)
      expect(partialDerivative).to.be.bignumber.gt(new BN("250000000000000000000"));
      expect(partialDerivative).to.be.bignumber.equal(new BN("260000000000000000000"));
      expect(partialDerivative).to.be.bignumber.lt(new BN("270000000000000000000"));
    });

    it("should calculate partial derivative with correct mathematical properties", async () => {
      // Test that partial derivatives behave correctly relative to each other
      const baseBalance = ethers.utils.parseUnits("1000000", 18);
      const higherBalance = ethers.utils.parseUnits("2000000", 18);

      const totalTokens = 4;
      const ampValue = 1000;
      const ampCoefficient = new BN(totalTokens ** totalTokens).mul(new BN(ampValue));
      const balancesSum = ethers.utils.parseUnits("4000000", 18);
      const poolInvariant = ethers.utils.parseUnits("4000000", 18);
      const ampPrecision = new BN("1000");

      const derivative1 = await rdOracle.testCalculatePartialDerivative(
        baseBalance,
        ampCoefficient,
        poolInvariant,
        balancesSum,
        ampPrecision
      );

      const derivative2 = await rdOracle.testCalculatePartialDerivative(
        higherBalance,
        ampCoefficient,
        poolInvariant,
        balancesSum,
        ampPrecision
      );

      // Mathematical properties of StableSwap:
      // 1. Partial derivatives should be positive
      expect(derivative1).to.be.bignumber.gt(new BN("0"));
      expect(derivative2).to.be.bignumber.gt(new BN("0"));

      // 2. As token balance increases, marginal utility decreases (diminishing returns)
      expect(derivative1).to.be.bignumber.gt(derivative2);

      // 3. Both should be reasonable values for high-amp StableSwap (expect ~250-270 range)
      expect(derivative1).to.be.bignumber.gt(new BN("250000000000000000000")); // > 250
      expect(derivative1).to.be.bignumber.lt(new BN("300000000000000000000")); // < 300
      expect(derivative2).to.be.bignumber.gt(new BN("100000000000000000000")); // > 100
      expect(derivative2).to.be.bignumber.lt(new BN("300000000000000000000")); // < 300
    });
  });
});
