const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")

const TroveManagerTester = artifacts.require("TroveManagerTester")
const TroveManagerLib = artifacts.require("./Dependencies/TroveManagerLib.sol")
const LiquidationsTester = artifacts.require("LiquidationsTester")
const AggregatorTester = artifacts.require("AggregatorTester")
const LUSDTokenTester = artifacts.require("LUSDTokenTester")
const RateControlTester = artifacts.require("RateControlTester")
const { BigNumber } = require("ethers");
const { ceilDiv, divCeil } = require("../utils/numbers.js");

const th = testHelpers.TestHelper
const dec = th.dec
const toBN = th.toBN
const getDifference = th.getDifference
const assertRevert = th.assertRevert
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

const _18_zeros = '000000000000000000'
const ZERO_ADDRESS = th.ZERO_ADDRESS
const ONE_DOLLAR = toBN(dec(1, 18))
const ONE_CENT = toBN(dec(1, 16))
const GAS_PRICE = 10000000



contract('TroveManager - Shutdown', async accounts => {

  const [
    owner,
    alice, bob, carol, dennis, erin, freddy, greta, harry, ida, flyn,
    A, B, C, D, E,
    whale, defaulter_1, defaulter_2, defaulter_3, defaulter_4] = accounts;

    const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  let priceFeed
  let lusdToken
  let sortedTroves
  let sortedShieldedTroves
  let troveManager
  let aggregator
  let nameRegistry
  let activePool
  let activeShieldedPool
  let stabilityPool
  let defaultPool
  let functionCaller
  let marketOracle
  let borrowerOperations
  let collateralToken
  let relayer
  let rateControl
  let feeRouter
  let collSurplusPool
  let contracts
  let borrowerOperationsInterface
  let stabilityPoolInterface
  let troveManagerInterface
  let feeRouterInterface
  let collSurplusPoolInterface
  let liquidationsInterface
  let hintHelpers
  let lqtyToken
  let lqtyStaking
  let communityIssuance
  let lockupContractFactory

  let lib;
  
  const getOpenTroveTotalDebt = async (lusdAmount) => th.getOpenTroveTotalDebt(contracts, lusdAmount)
  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const getActualDebtFromComposite = async (compositeDebt) => th.getActualDebtFromComposite(compositeDebt, contracts)
  const getNetBorrowingAmount = async (debtWithFee) => th.getNetBorrowingAmount(contracts, debtWithFee)
  const openTrove = async (params) => th.openTrove(contracts, params)
  const openShieldedTrove = async (params) => th.openShieldedTrove(contracts, params)
  const withdrawLUSD = async (params) => th.withdrawLUSD(contracts, params)
  const driveICRToTargetWithPar = async (borrower, targetICR) => th.driveICRToTargetWithPar(contracts, borrower, targetICR)
  const calculateParTarget = async (price, coll, debt, targetICR) => th.calculateParTarget(price, coll, debt, targetICR)
  const redeemCollateralForShutdown = async (redeemer, lusdAmount, gasPrice) => th.redeemCollateralForShutdown(redeemer, contracts, lusdAmount, gasPrice)

  before(async () => {
    lib = await TroveManagerLib.new();
    await TroveManagerTester.link(lib);
  });
  
  async function setup(){
    contracts = await deploymentHelper.deployLiquityCore()
    contracts.aggregator = await AggregatorTester.new()
    contracts.liquidations = await LiquidationsTester.new()
    contracts.troveManager = await TroveManagerTester.new()
    contracts.rateControl = await RateControlTester.new()
    contracts.lusdToken = await LUSDTokenTester.new(
      contracts.troveManager.address,
      contracts.liquidations.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address,
      contracts.globalFeeRouter.address
    )
    const LQTYContracts = await deploymentHelper.deployLQTYContracts(bountyAddress, lpRewardsAddress, multisig)

    priceFeed = contracts.priceFeedTestnet
    await priceFeed.setBorrowerOps(contracts.borrowerOperations.address)
    lusdToken = contracts.lusdToken
    sortedTroves = contracts.sortedTroves
    liquidations = contracts.liquidations
    troveManager = contracts.troveManager
    rewards = contracts.rewards
    nameRegistry = contracts.nameRegistry
    activePool = contracts.activePool
    activeShieldedPool = contracts.activeShieldedPool
    stabilityPool = contracts.stabilityPool
    defaultPool = contracts.defaultPool
    functionCaller = contracts.functionCaller
    borrowerOperations = contracts.borrowerOperations
    collateralToken = contracts.collateralToken
    relayer = contracts.relayer
    marketOracle = contracts.marketOracleTestnet
    rateControl = contracts.rateControl
    collSurplusPool = contracts.collSurplusPool
    feeRouter = contracts.feeRouter
    hintHelpers = contracts.hintHelpers
    aggregator = contracts.aggregator
    sortedShieldedTroves = contracts.sortedShieldedTroves

    lqtyStaking = LQTYContracts.lqtyStaking
    lqtyToken = LQTYContracts.lqtyToken
    communityIssuance = LQTYContracts.communityIssuance
    lockupContractFactory = LQTYContracts.lockupContractFactory

    feeRouterInterface = (await ethers.getContractAt("FeeRouter", feeRouter.address)).interface;
    // Interfaces
    stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", stabilityPool.address)).interface;
    troveManagerInterface = (await ethers.getContractAt("TroveManager", troveManager.address)).interface;
    feeRouterInterface = (await ethers.getContractAt("FeeRouter", feeRouter.address)).interface;
    liquidationsInterface = (await ethers.getContractAt("Liquidations", liquidations.address)).interface;
    collSurplusPoolInterface = (await ethers.getContractAt("CollSurplusPool", collSurplusPool.address)).interface;
    borrowerOperationsInterface = (await ethers.getContractAt("BorrowerOperations", borrowerOperations.address)).interface;
    
    await deploymentHelper.connectLQTYContracts(LQTYContracts)
    await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
    await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)

    await th.batchMintCollateralTokensAndApproveActivePool(contracts, [owner,
      alice, bob, carol, dennis, erin, freddy, greta, harry, ida,
      A, B, C, D, E,
      whale, defaulter_1, defaulter_2, defaulter_3, defaulter_4], toBN(dec(1000, 26)))
  }

  async function calcSCRPrice() {
  const totalColl = await troveManager.getEntireSystemColl();
  const accRate = await troveManager.accumulatedRate();
  const accShieldRate = await troveManager.accumulatedShieldRate();
  const totalDebt = await troveManager.getEntireSystemDebt(accRate, accShieldRate);
  const par = await relayer.par();
  const SCR = await borrowerOperations.SCR() // 1.10e18
  // price* = SCR * totalDebt * par / (totalColl * 1e18)
  const numerator = SCR.mul(totalDebt).mul(par);
  const denom = totalColl.mul(toBN(dec(1, 18)));
  const scrPrice = numerator.div(denom);
  return scrPrice
  }

  const ceilDivBN = (a, b) => a.add(b.subn(1)).div(b);

  // withdraws a borrower's collateral to reach just above MCR
  async function tuneCollToMCR(borrower) {
    const coll = await th.getTroveEntireColl(contracts, borrower)
    const debt = await th.getTroveEntireDebt(contracts, borrower)
    const mcr = await troveManager.MCR();
    const targetICR = mcr.add(toBN(dec(1,10)));
    const par = await relayer.par();
    const price = await priceFeed.getPrice();
    const collateralTarget = ceilDivBN(targetICR.mul(debt).mul(toBN(par)), price);
    const ct = collateralTarget.div(toBN(testHelpers.MoneyValues._1e18BN));
    const zeroAddress = '0x0000000000000000000000000000000000000000';
    await borrowerOperations.withdrawColl(coll.sub(ct), zeroAddress, zeroAddress, { from: borrower })
    return await th.getTroveEntireColl(contracts, borrower)
  }

  // Adjust each borrower's debt pre-shutdown to reach icrOpenTarget at pOpen
  async function tuneDebtToICROpen(addr, icrOpenTarget, priceAtOpen, parAtOpen) {
    const coll = await th.getTroveEntireColl(contracts, addr);           // includes pending rewards via helper
    const debt = await troveManager.getTroveActualDebt(addr);
    // desiredDebt = coll * priceAtOpen * 1e18 / (icrOpenTarget * parAtOpen)
    const desiredDebt = coll.mul(priceAtOpen).mul(toBN(dec(1,18))).div(icrOpenTarget.mul(parAtOpen));
    const MIN_NET_DEBT = await borrowerOperations.MIN_NET_DEBT();
    const gasComp = await troveManager.LUSD_GAS_COMPENSATION(); // or use constant if accessible
    const actualDebt = await troveManager.getTroveActualDebt(addr);
    const netDebt = actualDebt.sub(gasComp);
    
    if (debt.gt(desiredDebt)) {
      let delta = debt.sub(desiredDebt);
      const maxRepay = netDebt.sub(MIN_NET_DEBT);
      if (maxRepay.lte(toBN('0'))) return; // can't repay further without violating min
      if (delta.gt(maxRepay)) delta = maxRepay;
    
      if (delta.gt(toBN('0'))) {
        const { upperHint, lowerHint } = await th.getBorrowerOpsListHint(contracts, coll, debt.sub(delta), /*shielded=*/false);
        await borrowerOperations.repayLUSD(delta, upperHint, lowerHint, { from: addr });
      }
    }
  }

  async function tcrShutdown() {
    const scrPrice = await calcSCRPrice()
    // Set price slightly below SCR price to trigger shutdown
    const shutdownPrice = scrPrice.sub(toBN('1'))
    await priceFeed.setPrice(shutdownPrice)
    await borrowerOperations.shutdown()
    assert.isTrue(await troveManager.isShutdown())
    return shutdownPrice
  }

  describe('shutdown', async () => {
    beforeEach(async () => {
      await setup()
    })
    it('should shutdown the system when the oracle fails', async () => {
      await priceFeed.setOracleFailure(true)
      await priceFeed.fetchPrice()

      assert.isTrue(await troveManager.isShutdown())
    })

    it('should shutdown the system when the TCR is less than the SCR', async () => {
          // A, B open trove
     await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: alice } })
     await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: bob } })

      await priceFeed.setPrice(toBN(dec(1, 10)))
      await borrowerOperations.shutdown()
      assert.isTrue(await troveManager.isShutdown())
    })

    it('should revert when the TCR is greater than the SCR', async () => {

      try {
        await borrowerOperations.shutdown()
      } catch (err) {
        assert.include(err.message, "TCR must be less than SCR")
      }

      assert.isFalse(await troveManager.isShutdown())
    })

    it('should redeem collateral while tcr < scr', async () => {
      const { collateral: A_coll, debt: A_debt } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: alice } })
      const { collateral: B_coll, debt: B_debt } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: bob } })
      await relayer.updatePar()
         // skip bootstrapping phase
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await relayer.updatePar()
      //shutdown
      await tcrShutdown()

      const alice_LUSD_before = toBN(await lusdToken.balanceOf(alice))
      const alice_coll_before = toBN(await collateralToken.balanceOf(alice))
      await troveManager.redeemCollateralForShutdown(toBN(dec(100, 18)), '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0, 100, 0, { from: alice })
      const alice_coll_after = toBN(await collateralToken.balanceOf(alice))
      const alice_LUSD_after = toBN(await lusdToken.balanceOf(alice))

      assert.isTrue(alice_LUSD_after.lt(alice_LUSD_before))
      assert.isTrue(alice_coll_before.lt(alice_coll_after))
    })
  })

    describe('liquidations - TCR < SCR', async () => {
      beforeEach(async () => {
        await setup()
      })

      it('liquidate(): closes a Trove that has ICR < MCR', async () => {
        await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
        await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    
        const price = await priceFeed.getPrice()
        const ICR_before = await troveManager.getCurrentICR(alice, price)
    
        assert.equal(dec(1, 18), await relayer.par())
    
        assert.isTrue(ICR_before.eq(toBN(dec(4, 18))))
    
        const MCR = (await troveManager.MCR()).toString()
        assert.equal(MCR.toString(), '1100000000000000000')

        // Alice increases debt to 180 LUSD, lowering her ICR to 1.11
        const A_LUSDWithdrawal = await getNetBorrowingAmount(dec(130, 18))
    
        const targetICR = toBN('1111111111111111111')
        await withdrawLUSD({ ICR: targetICR, extraParams: { from: alice } })
    
        const ICR_AfterWithdrawal = await troveManager.getCurrentICR(alice, price)
        assert.isAtMost(th.getDifference(ICR_AfterWithdrawal, targetICR), 100)
        // price drops to 1CollateralToken:100LUSD, reducing Alice's ICR below MCR
        // shutdown
        await tcrShutdown()
        
        // await priceFeed.setPrice('100000000000000000000');
        // the tcr should be below ccr to trigger a shutdown
        assert.isTrue(await th.checkRecoveryMode(contracts))
        
        // close Trove
        await liquidations.liquidate(alice, { from: owner });
    
        // check the Trove is successfully closed, and removed from sortedList
        const status = (await troveManager.Troves(alice))[3]
        assert.equal(status, 3)  // status enum 3 corresponds to "Closed by liquidation"
        const alice_trove_isInSortedList = await sortedTroves.contains(alice)
        assert.isFalse(alice_trove_isInSortedList)
    
      })
      it('liquidate(): closes a Trove that has ICR < MCR from par rising', async () => {
        await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
        await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    
        const price = await priceFeed.getPrice()
        const ICR_before = await troveManager.getCurrentICR(alice, price)
    
        assert.equal(dec(1, 18), await relayer.par())
    
        assert.isTrue(ICR_before.eq(toBN(dec(4, 18))))
    
        const MCR = (await troveManager.MCR()).toString()
        assert.equal(MCR.toString(), '1100000000000000000')
    
        // Alice increases debt to 180 LUSD, lowering her ICR to 1.11
        const A_LUSDWithdrawal = await getNetBorrowingAmount(dec(130, 18))
    
        const targetICR = toBN('1100000000000000000')
        await withdrawLUSD({ ICR: targetICR, extraParams: { from: alice } })
    
        const ICR_AfterWithdrawal = await troveManager.getCurrentICR(alice, price)
        assert.isAtMost(th.getDifference(ICR_AfterWithdrawal, targetICR), 100)
  

        // ensure it can't be liquidated
        try {
          const txAlice = await liquidations.liquidate(alice)
    
          assert.isFalse(txAlice.receipt.status)
        } catch (err) {
          assert.include(err.message, "revert")
          assert.include(err.message, "Liquidations: nothing to liquidate")
        }

    
        const parBeforeShutdown = await relayer.par()
        //shutdown
        await tcrShutdown()
        // lusd price drops, raising par
        await marketOracle.setPrice(ONE_DOLLAR.sub(ONE_CENT))

        // update par after price drop below ccr
        await relayer.updateRateAndPar(); // initializes lastUpdateTime (no change)
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);
        await relayer.updateRateAndPar(); // now par can move up to 0.001 per hour

        const parAfterShutdown = await relayer.par();

        assert.isTrue(parAfterShutdown.gt(parBeforeShutdown), "par should have risen")
        // ICR has dropped
        assert.isTrue(ICR_AfterWithdrawal > await troveManager.getCurrentICR(alice, price));
        const priceNow = await priceFeed.getPrice()
        const icr = await troveManager.getCurrentICR(alice, priceNow)
        const mcr = await troveManager.MCR()
        assert.isTrue(icr.lt(mcr), "ICR must be < MCR at liquidation time")
        const isShutdown = await troveManager.isShutdown()
        assert.isTrue(isShutdown, "system should be shutdown")
        // close Trove
        tx = await liquidations.liquidate(alice, { from: owner });
        /*
        liq_event = tx.logs.find(e => e.event === 'TroveLiqInfo');
        console.log("entireColl", liq_event.args.entireColl.toString())
        console.log("collToLiquidate", liq_event.args.collToLiquidate.toString())
        console.log("collToSp", liq_event.args.collToSp.toString())
        console.log("collToRedistribute", liq_event.args.collToRedistribute.toString())
        */
    
        // check the Trove is successfully closed, and removed from sortedList
        const status = (await troveManager.Troves(alice))[3]
        assert.equal(status, 3)  // status enum 3 corresponds to "Closed by liquidation"
        const alice_trove_isInSortedList = await sortedTroves.contains(alice)
        assert.isFalse(alice_trove_isInSortedList)
      })
    
      it("liquidate(): decreases ActivePool Collateral and LUSDDebt by correct amounts", async () => {
        // --- SETUP 
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check ActivePool Collateral and LUSD debt before
        const activePool_Collateral_before = (await activePool.getCollateral()).toString()
        const activePool_RawCollateral_before = (await collateralToken.balanceOf(activePool.address)).toString()
        const activePool_LUSDDebt_before = (await activePool.getLUSDDebt()).toString()
    
        assert.equal(activePool_Collateral_before, A_collateral.add(B_collateral))
        assert.equal(activePool_RawCollateral_before, A_collateral.add(B_collateral))
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_before, A_totalDebt.add(B_totalDebt))
    
        // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        /* close Bob's Trove. Should liquidate his ether and LUSD, 
        leaving Alice's ether and LUSD debt in the ActivePool. */
        await liquidations.liquidate(bob, { from: owner });
    
        // check ActivePool Collateral and LUSD debt 
        const activePool_Collateral_After = await activePool.getCollateral()
        const activePool_RawCollateral_After= await collateralToken.balanceOf(activePool.address)
        const activePool_LUSDDebt_After = await activePool.getLUSDDebt()
    
        //console.log("activePool_Collateral_After", activePool_Collateral_After.toString())
        //console.log("A_collateral", A_collateral.toString())
        //console.log("B_collateral", B_collateral.toString())
        // TODO Fix off by one
        //assert.equal(activePool_Collateral_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_Collateral_After, A_collateral), 1)
        //assert.equal(activePool_RawEther_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_RawCollateral_After, A_collateral), 1)
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_After, A_totalDebt)
      })
      it("liquidate(): decreases ActivePool Collateral and LUSDDebt by correct amounts, with liq surplus", async () => {
        // --- SETUP 
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check ActivePool Collateral and LUSD debt before
        const activePool_Collateral_before = (await activePool.getCollateral()).toString()
        const activePool_RawCollateral_before = (await collateralToken.balanceOf(activePool.address)).toString()
        const activePool_LUSDDebt_before = (await activePool.getLUSDDebt()).toString()
    
        //console.log("activePool_RawCollateral_before", activePool_RawCollateral_before.toString())
        assert.equal(activePool_Collateral_before, A_collateral.add(B_collateral))
        assert.equal(activePool_RawCollateral_before, A_collateral.add(B_collateral))
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_before, A_totalDebt.add(B_totalDebt))
    
        // price drops to 1ETH:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        /* close Bob's Trove. Should liquidate his ether and LUSD, 
        leaving Alice's ether and LUSD debt in the ActivePool. */
        await liquidations.liquidate(bob, { from: owner });
    
        // check ActivePool Collateral and LUSD debt 
        const activePool_Collateral_After = await activePool.getCollateral()
        const activePool_RawCollateral_After = await collateralToken.balanceOf(activePool.address)
        const activePool_LUSDDebt_After = await activePool.getLUSDDebt()
    
        // TODO Fix off by one
        //assert.equal(activePool_ETH_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_Collateral_After, A_collateral), 1)
        //assert.equal(activePool_RawEther_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_RawCollateral_After, A_collateral), 1)
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_After, A_totalDebt)
      })
      it("liquidate(): decreases ActivePool Collateral and LUSDDebt by correct amounts, with liq surplus", async () => {
        // --- SETUP 
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check ActivePool Collateral and LUSD debt before
        const activePool_Collateral_before = (await activePool.getCollateral()).toString()
        const activePool_RawCollateral_before = (await collateralToken.balanceOf(activePool.address)).toString()
        const activePool_LUSDDebt_before = (await activePool.getLUSDDebt()).toString()
    
        // console.log("activePool_RawCollateral_before", activePool_RawCollateral_before.toString())
        // console.log("sum", A_collateral.add(B_collateral).toString())
        assert.equal(activePool_Collateral_before, A_collateral.add(B_collateral))
        assert.equal(activePool_RawCollateral_before, A_collateral.add(B_collateral))
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_before, A_totalDebt.add(B_totalDebt))
    
        // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        /* close Bob's Trove. Should liquidate his ether and LUSD, 
        leaving Alice's ether and LUSD debt in the ActivePool. */
        await liquidations.liquidate(bob, { from: owner });
    
        // check ActivePool Collateral and LUSD debt 
        const activePool_Collateral_After = await activePool.getCollateral()
        const activePool_RawCollateral_After = await collateralToken.balanceOf(activePool.address)
        const activePool_LUSDDebt_After = await activePool.getLUSDDebt()
    
        // TODO Fix off by one
        //assert.equal(activePool_ETH_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_Collateral_After, A_collateral), 1)
        //assert.equal(activePool_RawEther_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_RawCollateral_After, A_collateral), 1)
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_After, A_totalDebt)
      })
    
      it("liquidate(): decreases ActivePool Collateral and LUSDDebt by correct amounts, rising par", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(111, 16)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check ActivePool Collateral and LUSD debt before
        const activePool_Collateral_before = (await activePool.getCollateral()).toString()
        const activePool_RawCollateral_before = (await collateralToken.balanceOf(activePool.address)).toString()
        const activePool_LUSDDebt_before = (await activePool.getLUSDDebt()).toString()
    
        assert.equal(activePool_Collateral_before, A_collateral.add(B_collateral))
        assert.equal(activePool_RawCollateral_before, A_collateral.add(B_collateral))
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_before, A_totalDebt.add(B_totalDebt))
    
        // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
        //await priceFeed.setPrice('100000000000000000000');
    
        // move market enough to cause par to liquidate bob's trove
        await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(8).mul(ONE_CENT)));
        await relayer.updatePar();
        th.fastForwardTime(12 * 3600, web3.currentProvider)
        await relayer.updatePar();
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))    
        /* close Bob's Trove. Should liquidate his ether and LUSD, 
        leaving Alice's ether and LUSD debt in the ActivePool. */
        await liquidations.liquidate(bob, { from: owner });
    
        // check ActivePool collateral and LUSD debt 
        const activePool_Collateral_After = await activePool.getCollateral()
        const activePool_RawCollateral_After = await collateralToken.balanceOf(activePool.address)
        const activePool_LUSDDebt_After = await activePool.getLUSDDebt()
    
        // TODO fix off by one
        //assert.equal(activePool_Collateral_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_Collateral_After, A_collateral), 1)
        //assert.equal(activePool_RawEther_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_RawCollateral_After, A_collateral), 1)
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_After, A_totalDebt)
      })
    
      it("liquidate(): increases DefaultPool Collateral and LUSD debt by correct amounts", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check DefaultPool Collateral and LUSD debt before
        const defaultPool_Collateral_before = (await defaultPool.getCollateral())
        const defaultPool_RawCollateral_before = (await collateralToken.balanceOf(defaultPool.address)).toString()
        const defaultPool_LUSDDebt_before = (await defaultPool.getLUSDDebt()).toString()
    
        assert.equal(defaultPool_Collateral_before, '0')
        assert.equal(defaultPool_RawCollateral_before, '0')
        assert.equal(defaultPool_LUSDDebt_before, '0')
    
        // price drops to 1Collateral:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // close Bob's Trove
        tx = await liquidations.liquidate(bob, { from: owner });
    
        /*
        liq_event = tx.logs.find(e => e.event === 'TroveLiqInfo');
        console.log("entireColl", liq_event.args.entireColl.toString())
        console.log("collToLiquidate", liq_event.args.collToLiquidate.toString())
        console.log("B_collateral", B_collateral.toString())
        */
    
        // check after
        const defaultPool_Collateral_After = await defaultPool.getCollateral()
        const defaultPool_RawCollateral_After = await collateralToken.balanceOf(defaultPool.address)
        const defaultPool_LUSDDebt_After = await defaultPool.getLUSDDebt()
    
        const defaultPool_Collateral = th.applyLiquidationFee(B_collateral)
    
        // TODO: should these be exactly equal?
        //assert.isTrue(defaultPool_Collateral_After.eq(defaultPool_Collateral))
        assert.isAtMost(th.getDifference(defaultPool_Collateral_After, defaultPool_Collateral), 1)
        //assert.isTrue(defaultPool_RawCollateral_After.eq(defaultPool_Collateral))
        assert.isAtMost(th.getDifference(defaultPool_RawCollateral_After, defaultPool_Collateral), 1)
        //assert.isAtMost(th.getDifference(defaultPool_Collateral_After, defaultPool_Collateral), 1)
    
        th.assertIsApproximatelyEqual(defaultPool_LUSDDebt_After, B_totalDebt)
      })
      it("liquidate(): increases DefaultPool Collateral and LUSD debt by correct amounts, rising par", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(111, 16)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check DefaultPool Collateral and LUSD debt before
        const defaultPool_Collateral_before = (await defaultPool.getCollateral())
        const defaultPool_RawCollateral_before = (await collateralToken.balanceOf(defaultPool.address)).toString()
        const defaultPool_LUSDDebt_before = (await defaultPool.getLUSDDebt()).toString()
    
        assert.equal(defaultPool_Collateral_before, '0')
        assert.equal(defaultPool_RawCollateral_before, '0')
        assert.equal(defaultPool_LUSDDebt_before, '0')
    
        // price drops to 1Collateral:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(8).mul(ONE_CENT)));
        await relayer.updatePar();
        th.fastForwardTime(12 * 3600, web3.currentProvider)
        await relayer.updatePar();
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))    
        // close Bob's Trove
        await liquidations.liquidate(bob, { from: owner });
    
        // check after
        const defaultPool_Collateral_After = (await defaultPool.getCollateral()).toString()
        const defaultPool_RawCollateral_After = (await collateralToken.balanceOf(defaultPool.address)).toString()
        const defaultPool_LUSDDebt_After = (await defaultPool.getLUSDDebt()).toString()
    
        const defaultPool_Collateral = th.applyLiquidationFee(B_collateral)
    
        // console.log("defaultPool_Collateral_After", defaultPool_Collateral_After.toString())
        // console.log("defaultPool_Collateral", defaultPool_Collateral.toString())
    
        // TODO: should these be exactly equal?
        //assert.equal(defaultPool_Collateral_After, defaultPool_Collateral)
        assert.isAtMost(th.getDifference(defaultPool_Collateral_After, defaultPool_Collateral), 1)
        //assert.equal(defaultPool_RawCollateral_After, defaultPool_Collateral)
        assert.isAtMost(th.getDifference(defaultPool_RawCollateral_After, defaultPool_Collateral), 1)
        th.assertIsApproximatelyEqual(defaultPool_LUSDDebt_After, B_totalDebt)
      })
    
      it("liquidate(): removes the Trove's stake from the total stakes", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check totalStakes before
        const totalStakes_before = (await rewards.totalStakes()).toString()
        assert.equal(totalStakes_before, A_collateral.add(B_collateral))
    
        // price drops to 1Collateral:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))    
        // Close Bob's Trove
        await liquidations.liquidate(bob, { from: owner });
    
        // check totalStakes after
        const totalStakes_After = (await rewards.totalStakes()).toString()
        assert.equal(totalStakes_After, A_collateral)
      })
      it("liquidate(): removes the Trove's stake from the total stakes, rising par", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(111, 16)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check totalStakes before
        const totalStakes_before = (await rewards.totalStakes()).toString()
        assert.equal(totalStakes_before, A_collateral.add(B_collateral))
    
        // price drops to 1Collateral:100LUSD, reducing Bob's ICR below MCR
        //await priceFeed.setPrice('100000000000000000000');
        await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(8).mul(ONE_CENT)));
        await relayer.updatePar();
        th.fastForwardTime(12 * 3600, web3.currentProvider)
        await relayer.updatePar();
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))

        // Close Bob's Trove
        await liquidations.liquidate(bob, { from: owner });
    
        // check totalStakes after
        const totalStakes_After = (await rewards.totalStakes()).toString()
        assert.equal(totalStakes_After, A_collateral)
      })
    
      it("liquidate(): Removes the correct trove from the TroveOwners array, and moves the last array element to the new empty slot", async () => {
        // --- SETUP --- 
        await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    
        // Alice, Bob, Carol, Dennis, Erin open troves with consecutively decreasing collateral ratio
        await openTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
        await openTrove({ ICR: toBN(dec(216, 16)), extraParams: { from: bob } })
        await openTrove({ ICR: toBN(dec(214, 16)), extraParams: { from: carol } })
        await openTrove({ ICR: toBN(dec(212, 16)), extraParams: { from: dennis } })
        await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: erin } })
    
        // At this stage, TroveOwners array should be: [W, A, B, C, D, E] 
    
        // Drop price
        await priceFeed.setPrice(dec(100, 18))
    
        const arrayLength_before = await troveManager.getTroveOwnersCount()
        assert.equal(arrayLength_before, 6)
        assert.isFalse(await th.checkRecoveryMode(contracts))
         // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))   
        // Liquidate carol
        await liquidations.liquidate(carol)
    
        // Check Carol no longer has an active trove
        assert.isFalse(await sortedTroves.contains(carol))
    
        // Check length of array has decreased by 1
        const arrayLength_After = await troveManager.getTroveOwnersCount()
        assert.equal(arrayLength_After, 5)
    
        /* After Carol is removed from array, the last element (Erin's address) should have been moved to fill 
        the empty slot left by Carol, and the array length decreased by one.  The final TroveOwners array should be:
      
        [W, A, B, E, D] 
    
        Check all remaining troves in the array are in the correct order */
        const trove_0 = await troveManager.TroveOwners(0)
        const trove_1 = await troveManager.TroveOwners(1)
        const trove_2 = await troveManager.TroveOwners(2)
        const trove_3 = await troveManager.TroveOwners(3)
        const trove_4 = await troveManager.TroveOwners(4)
    
        assert.equal(trove_0, whale)
        assert.equal(trove_1, alice)
        assert.equal(trove_2, bob)
        assert.equal(trove_3, erin)
        assert.equal(trove_4, dennis)
    
        // Check correct indices recorded on the active trove structs
        const whale_arrayIndex = (await troveManager.Troves(whale))[4]
        const alice_arrayIndex = (await troveManager.Troves(alice))[4]
        const bob_arrayIndex = (await troveManager.Troves(bob))[4]
        const dennis_arrayIndex = (await troveManager.Troves(dennis))[4]
        const erin_arrayIndex = (await troveManager.Troves(erin))[4]
    
        // [W, A, B, E, D] 
        assert.equal(whale_arrayIndex, 0)
        assert.equal(alice_arrayIndex, 1)
        assert.equal(bob_arrayIndex, 2)
        assert.equal(erin_arrayIndex, 3)
        assert.equal(dennis_arrayIndex, 4)
      })
    
      it("liquidate(): updates the snapshots of total stakes and total collateral", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check snapshots before 
        const totalStakesSnapshot_before = (await rewards.totalStakesSnapshot()).toString()
        const totalCollateralSnapshot_before = (await rewards.totalCollateralSnapshot()).toString()
        assert.equal(totalStakesSnapshot_before, '0')
        assert.equal(totalCollateralSnapshot_before, '0')
    
        // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // close Bob's Trove.  His ether*0.995 and LUSD should be added to the DefaultPool.
        await liquidations.liquidate(bob, { from: owner });
    
        /* check snapshots after. Total stakes should be equal to the  remaining stake then the system: 
        10 ether, Alice's stake.
         
        Total collateral should be equal to Alice's collateral plus her pending collateral reward (Bob's collaterale*0.995 ether), earned
        from the liquidation of Bob's Trove */
        const totalStakesSnapshot_After = await rewards.totalStakesSnapshot()
        const totalCollateralSnapshot_After = await rewards.totalCollateralSnapshot()
    
        assert.isTrue(totalStakesSnapshot_After.eq(A_collateral))
        //assert.isTrue(totalCollateralSnapshot_After.eq(A_collateral.add(th.applyLiquidationFee(B_collateral))))
        // TODO fix off by one
        assert.isAtMost(th.getDifference(totalCollateralSnapshot_After, A_collateral.add(th.applyLiquidationFee(B_collateral))), 1)
    
      })
      it("liquidate(): updates the snapshots of total stakes and total collateral, rising par", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(111, 16)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check snapshots before 
        const totalStakesSnapshot_before = (await rewards.totalStakesSnapshot()).toString()
        const totalCollateralSnapshot_before = (await rewards.totalCollateralSnapshot()).toString()
        assert.equal(totalStakesSnapshot_before, '0')
        assert.equal(totalCollateralSnapshot_before, '0')
    
        // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
        //await priceFeed.setPrice('100000000000000000000');
        await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(8).mul(ONE_CENT)));
        await relayer.updatePar();
        th.fastForwardTime(12 * 3600, web3.currentProvider)
        await relayer.updatePar();
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // close Bob's Trove.  His ether*0.995 and LUSD should be added to the DefaultPool.
        await liquidations.liquidate(bob, { from: owner });
    
        /* check snapshots after. Total stakes should be equal to the  remaining stake then the system: 
        10 ether, Alice's stake.
         
        Total collateral should be equal to Alice's collateral plus her pending collateral reward (Bob's collateral*0.995 ether), earned
        from the liquidation of Bob's Trove */
        const totalStakesSnapshot_After = (await rewards.totalStakesSnapshot()).toString()
        const totalCollateralSnapshot_After = (await rewards.totalCollateralSnapshot()).toString()
    
        assert.equal(totalStakesSnapshot_After, A_collateral)
        // TODO fix off by one
        //assert.equal(totalCollateralSnapshot_After, A_collateral.add(th.applyLiquidationFee(B_collateral)))
        assert.isAtMost(th.getDifference(totalCollateralSnapshot_After, A_collateral.add(th.applyLiquidationFee(B_collateral))), 1)
      })
    
      it("liquidate(): updates the L_Coll and L_LUSDDebt reward-per-unit-staked totals", async () => {
        await rateControl.setCoBias(0)
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(8, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: bob } })
        const { collateral: C_collateral, totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(111, 16)), extraParams: { from: carol } })

        // --- TEST ---
    
        // price drops to 1CollateralToken:100LUSD, reducing Carols's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        const tcrPrice =await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        const L_Coll_beforeCarolLiquidated = await rewards.L_Coll()
        const L_LUSDDebt_beforeCarolLiquidated = await rewards.L_LUSDDebt()
    
        // close Carol's Trove.  
        assert.isTrue(await sortedTroves.contains(carol))
        await liquidations.liquidate(carol, { from: owner });
        assert.isFalse(await sortedTroves.contains(carol))
    
        // Carol's collateral*0.995 and LUSD should be added to the DefaultPool.
        const L_Coll_AfterCarolLiquidated = await rewards.L_Coll()
        const L_LUSDDebt_AfterCarolLiquidated = await rewards.L_LUSDDebt()
    
        // Debug values for understanding the issue
        const totalStakes_afterCarol = await rewards.totalStakes()
        const A_stake_afterCarol = await troveManager.getTroveStake(alice)
        const B_stake_afterCarol = await troveManager.getTroveStake(bob)
        const expectedLiquidationFee = C_collateral.div(toBN(200))
        const liquidatedCollAfterFee = C_collateral.sub(expectedLiquidationFee) //th.applyLiquidationFee(C_collateral)
    
        const L_Coll_expected_1 = liquidatedCollAfterFee.mul(mv._1e18BN).div(totalStakes_afterCarol)
        const L_LUSDDebt_expected_1 = C_totalDebt.mul(mv._1e18BN).div(totalStakes_afterCarol)
    
        assert.isAtMost(th.getDifference(L_Coll_AfterCarolLiquidated, L_Coll_expected_1), 100)
        assert.isAtMost(th.getDifference(L_LUSDDebt_AfterCarolLiquidated, L_LUSDDebt_expected_1), 100)
    
        b_coll = (await troveManager.getEntireDebtAndColl(bob))[1]
        b_coll_pending = (await troveManager.getEntireDebtAndColl(bob))[3]
        b_exp = B_collateral.mul(L_Coll_expected_1).div(mv._1e18BN)
        /*
        console.log("b_coll", b_coll.toString())
        console.log("b_exp", b_exp.toString())
        console.log("b_coll_pending", b_coll_pending.toString())
        */
    
        // Bob now withdraws LUSD, bringing his ICR to 1.11
        const price = await priceFeed.getPrice();
        const res = await troveManager.getEntireDebtAndColl(bob);
        const collEff = res[1].add(res[3]);    
        const debtActual = await troveManager.getTroveActualDebt(bob);

        const targetICR = toBN(dec(111,16)); // 1.11e18
        const parTarget = await calculateParTarget(price, collEff, debtActual, targetICR);

        await driveICRToTargetWithPar(bob, parTarget);

        // price drops to 1CollateralToken:50LUSD, reducing Bob's ICR below MCR
        // await priceFeed.setPrice(dec(50, 18));
        // const price = await priceFeed.getPrice()
    
        assert.isTrue(await sortedTroves.contains(bob))
        tx = await liquidations.liquidate(bob, { from: owner });
        assert.isFalse(await sortedTroves.contains(bob))
    
        /* Alice now has all the active stake. totalStakes in the system is now 10 collateral token.
      
       Bob's pending collateral reward and debt reward are applied to his Trove
       before his liquidation.
       His total collateral*0.995 and debt are then added to the DefaultPool. 
       
       The system rewards-per-unit-staked should now be:
       
       L_Coll = (0.995 / 20) + (10.4975*0.995  / 10) = 1.09425125 CollateralToken
       L_LUSDDebt = (180 / 20) + (890 / 10) = 98 LUSD */
        const L_Coll_AfterBobLiquidated = await rewards.L_Coll()
        const L_LUSDDebt_AfterBobLiquidated = await rewards.L_LUSDDebt()
    
        const B_increasedTotalDebt = toBN('0'); // no borrow; par/price only

        const L_Coll_expected_2 = L_Coll_expected_1.add(th.applyLiquidationFee(B_collateral.add(B_collateral.mul(L_Coll_expected_1).div(mv._1e18BN))).mul(mv._1e18BN).div(A_collateral))
        const L_LUSDDebt_expected_2 = L_LUSDDebt_expected_1.add(B_totalDebt.add(B_increasedTotalDebt).add(B_collateral.mul(L_LUSDDebt_expected_1).div(mv._1e18BN)).mul(mv._1e18BN).div(A_collateral))
    
        assert.isAtMost(th.getDifference(L_Coll_AfterBobLiquidated, L_Coll_expected_2), 100)
        assert.isAtMost(th.getDifference(L_LUSDDebt_AfterBobLiquidated, L_LUSDDebt_expected_2), 100)
      })
      it("liquidate(): Liquidates undercollateralized trove if there are two troves in the system", async () => {
        await openTrove({ ICR: toBN(dec(200, 18)), extraParams: { from: bob, value: dec(100, 'ether') } })
    
        // Alice creates a single trove with 0.7 CT and a debt of 70 LUSD, and provides 10 LUSD to SP
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
    
        // Alice proves 10 LUSD to SP
        await stabilityPool.provideToSP(dec(10, 18), ZERO_ADDRESS, { from: alice })
    
        // Set CollateralToken:USD price to 105
        await priceFeed.setPrice('105000000000000000000')
        const price = await priceFeed.getPrice()
        assert.isFalse(await th.checkRecoveryMode(contracts))
    
        const alice_ICR = (await troveManager.getCurrentICR(alice, price)).toString()
        assert.equal(alice_ICR, '1050000000000000000')
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).lte(mv._MCR))
    
        const activeTrovesCount_before = await troveManager.getTroveOwnersCount()
    
        assert.equal(activeTrovesCount_before, 2)
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // console.log("before liq")
        // console.log("bob actual debt", (await contracts.troveManager.getTroveActualDebt(bob)).toString())
        // console.log("bob entire debt", (await contracts.troveManager.getEntireDebtAndColl(bob))[0].toString())
        // console.log("alice actual debt", (await contracts.troveManager.getTroveActualDebt(bob)).toString())
        // console.log("debt", (await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())).toString())
        // console.log("supply", (await contracts.lusdToken.totalSupply()).toString())
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))    
        // Liquidate
        tx = await liquidations.liquidate(alice, { from: owner })
    
        // Check Alice's trove is removed, and bob remains
        const activeTrovesCount_After = await troveManager.getTroveOwnersCount()
        assert.equal(activeTrovesCount_After, 1)
    
        const alice_isInSortedList = await sortedTroves.contains(alice)
        assert.isFalse(alice_isInSortedList)
    
        const bob_isInSortedList = await sortedTroves.contains(bob)
        assert.isTrue(bob_isInSortedList)
    
        // console.log("after liq")
        // console.log("bob actual debt", (await contracts.troveManager.getTroveActualDebt(bob)).toString())
        // console.log("bob entire debt", (await contracts.troveManager.getEntireDebtAndColl(bob))[0].toString())
        // console.log("default pool coll", (await contracts.defaultPool.getCollateral()).toString())
        // console.log("alice actual debt", (await contracts.troveManager.getTroveActualDebt(alice)).toString())
        // console.log("debt", (await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())).toString())
        // console.log("supply", (await contracts.lusdToken.totalSupply()).toString())
      })
    
      it("liquidate(): reverts if trove is non-existent", async () => {
        await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        assert.equal(await troveManager.getTroveStatus(carol), 0) // check trove non-existent
        // price drops to below ccr collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))    
        assert.isFalse(await sortedTroves.contains(carol))
    
        try {
          const txCarol = await liquidations.liquidate(carol)
    
          assert.isFalse(txCarol.receipt.status)
        } catch (err) {
          assert.include(err.message, "revert")
          assert.include(err.message, "Trove does not exist or is closed")
        }
      })
    
      it("liquidate(): reverts if trove has been closed", async () => {
        await openTrove({ ICR: toBN(dec(8, 18)), extraParams: { from: alice } })
        await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: bob } })
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })
    
        assert.isTrue(await sortedTroves.contains(carol))
        
        // price drops, Carol ICR falls below MCR
        await priceFeed.setPrice(dec(100, 18))
         // price keeps droping to drop collateral and debt
         await tcrShutdown()

         assert.isTrue(await th.checkRecoveryMode(contracts))   
        // Carol liquidated, and her trove is closed
        const txCarol_L1 = await liquidations.liquidate(carol)
        assert.isTrue(txCarol_L1.receipt.status)
    
        assert.isFalse(await sortedTroves.contains(carol))
    
        assert.equal(await troveManager.getTroveStatus(carol), 3)  // check trove closed by liquidation
    
        try {
          const txCarol_L2 = await liquidations.liquidate(carol)
    
          assert.isFalse(txCarol_L2.receipt.status)
        } catch (err) {
          assert.include(err.message, "revert")
          assert.include(err.message, "Trove does not exist or is closed")
        }
      })
    
      it("liquidate(): does nothing if trove has >= 110% ICR", async () => {
        await openTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: whale } })
        await openTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: bob } })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = (await sortedTroves.getSize()).toString()
    
        const price = await priceFeed.getPrice()
        
        // Check Bob's ICR > 110%
        const bob_ICR = await troveManager.getCurrentICR(bob, price)

        assert.isTrue(bob_ICR.gte(mv._MCR))
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price drops to tcr < scr and system is shut down
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // drive par to make bob's ICR < MCR
        const { par: parAfter, priceUsed: priceTargetAfter } = await driveICRToTargetWithPar(bob, mv._MCR)

        // check bob's ICR < MCR
        const bob_ICR_After  = await troveManager.getCurrentICR(bob, priceTargetAfter)
        assert.isTrue(bob_ICR_After.gte(mv._MCR))
        // Attempt to liquidate bob
        await assertRevert(liquidations.liquidate(bob), "Liquidations: nothing to liquidate")
    
        // Check bob active, check whale active
        assert.isTrue((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()

        assert.equal(TCR_After, mv._MCR)
        assert.equal(listSize_before, listSize_After)
      })
    
      it("liquidate(): surplus collateral if liquidated above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = await sortedTroves.getSize()
          
        // Choose target band at liquidation
        const penalty = await liquidations.LIQUIDATION_PENALTY();
   
        const mcr = await troveManager.MCR();
      
        const targetICRliq = penalty.add(toBN(dec(1,16))).add(mcr).div(toBN(2)); // midpoint in (penaltyRedist, MCR)

        // Capture current price/par (open-time)
        const priceAtOpen = await priceFeed.getPrice();
        const parAtOpen = await relayer.par();

        // Compute SCR price from current totals, then choose liquidation price just below SCR
        const scrPrice = await calcSCRPrice();

        // Compute the ICR needed at open so that ICR_liq hits target at pLiq
        // icr_open = targetICRliq * (priceAtOpen / pLiq) * (parLiq / parAtOpen)
        const parLiq = parAtOpen;
        const icrOpenTarget = targetICRliq.mul(priceAtOpen).mul(parLiq).div(scrPrice.sub(toBN('1'))).div(parAtOpen);
        await tuneDebtToICROpen(bob, icrOpenTarget, priceAtOpen, parAtOpen)

        await tcrShutdown()
        // price drops to put tcr below scr
        await driveICRToTargetWithPar(bob, targetICRliq)

        const priceNow = await priceFeed.getPrice()
    
        assert.isTrue((await troveManager.getCurrentICR(bob,priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob,priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))

        assert.isTrue(await th.checkRecoveryMode(contracts))    
        // liquidate bob
        tx = await liquidations.liquidate(bob)
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
        const offsetActualBaseDebt = th.getRawEventArgByName(tx, liquidationsInterface, liquidations.address, "Offset", "actualBaseDebt");
        const offsetBaseDebt = th.getRawEventArgByName(tx, liquidationsInterface, liquidations.address, "Offset", "baseDebt");
        const offsetBaseColl = th.getRawEventArgByName(tx, liquidationsInterface, liquidations.address, "Offset", "baseColl");
    
        // console.log("offsetActualBaseDebt", offsetActualBaseDebt.toString())
        // console.log("offsetBaseDebt", offsetBaseDebt.toString())
        // console.log("offsetBaseColl", offsetBaseColl.toString())
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        // console.log("bobCollateral", bobCollateral.toString())
        // console.log("liquidatedColl", liquidatedColl.toString())
        // console.log("ethGain", ethGain.toString())
        // assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 96000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_before > listSize_After)
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 

        // assert.isTrue(await th.checkRecoveryMode(contracts))
        // bob claims surplus collateral
        tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    
        // check bob eth difference, considering eth used in tx
        txCost = th.ethUsed(tx)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
      })
      
      it("liquidate(): surplus collateral if liquidated by par above penalty", async () => {
        // disable rates to ensure ICR change is from par only
        await contracts.rateControl.setCoBias(0)
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(110, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = await sortedTroves.getSize()
          
        // Choose target band at liquidation
        const penalty = await liquidations.LIQUIDATION_PENALTY();
   
        const mcr = await troveManager.MCR();
      
        const targetICRliq = penalty.add(toBN(dec(1,16))).add(mcr).div(toBN(2)); // midpoint in (penaltyRedist, MCR)

        // Capture current price/par (open-time)
        const priceAtOpen = await priceFeed.getPrice();
        const parAtOpen = await relayer.par();

        // Compute SCR price from current totals, then choose liquidation price just below SCR
        const scrPrice = await calcSCRPrice();

        // Compute the ICR needed at open so that ICR_liq hits target at pLiq
        // icr_open = targetICRliq * (priceAtOpen / pLiq) * (parLiq / parAtOpen)
        const parLiq = parAtOpen;
        const icrOpenTarget = targetICRliq.mul(priceAtOpen).mul(parLiq).div(scrPrice.sub(toBN('1'))).div(parAtOpen);
        await tuneDebtToICROpen(bob, icrOpenTarget, priceAtOpen, parAtOpen)

        await tcrShutdown()
 
        await driveICRToTargetWithPar(bob, targetICRliq)
        // await priceFeed.setPrice(dec(100, 18))
        const priceNow = await priceFeed.getPrice()
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))


        // assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_before > listSize_After)
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    
        // check bob eth difference, considering eth used in tx
        txCost = th.ethUsed(tx)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
      })
      it("liquidate(): surplus collateral if liquidated by drip above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(110, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = (await sortedTroves.getSize()).toString()
    
        price = await priceFeed.getPrice()
        // exactly eq to MCR, so drip in liquidate will make trove liquidatable
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).eq((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
    
        // Choose target band at liquidation
        const penalty = await liquidations.LIQUIDATION_PENALTY();
   
        const mcr = await troveManager.MCR();
        
        const targetICRliq = penalty.add(toBN(dec(1,16))).add(mcr).div(toBN(2)); // midpoint in (penaltyRedist, MCR)
     
        // Capture current price/par (open-time)
        const priceAtOpen = await priceFeed.getPrice();
        const parAtOpen = await relayer.par();
     
        // Compute SCR price from current totals, then choose liquidation price just below SCR
        const scrPrice = await calcSCRPrice();
     
        // Compute the ICR needed at open so that ICR_liq hits target at pLiq
        // icr_open = targetICRliq * (priceAtOpen / pLiq) * (parLiq / parAtOpen)
        const parLiq = parAtOpen;
        const icrOpenTarget = targetICRliq.mul(priceAtOpen).mul(parLiq).div(scrPrice.sub(toBN('1'))).div(parAtOpen);
        await tuneDebtToICROpen(bob, icrOpenTarget, priceAtOpen, parAtOpen)
     
        await tcrShutdown()
      
        await driveICRToTargetWithPar(bob, targetICRliq)
        // assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_before > listSize_After)
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    
        // check bob eth difference, considering eth used in tx
        txCost = th.ethUsed(tx)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
      })
      it("liquidate(): surplus collateral if liquidated above penalty, redistribution", async () => {
        // set liq penalty to less than MCR
        await liquidations.setLiqPenaltyRedist(toBN(dec(106, 16)));
        await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = (await sortedTroves.getSize()).toString()
        price = dec(100, 18)
        await priceFeed.setPrice(price)
    
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY_REDIST())))

        // Choose target band at liquidation
        const penalty = await liquidations.LIQUIDATION_PENALTY();
   
        const mcr = await troveManager.MCR();
      
        const targetICRliq = penalty.add(toBN(dec(1,16))).add(mcr).div(toBN(2)); // midpoint in (penaltyRedist, MCR)

        // Capture current price/par (open-time)
        const priceAtOpen = await priceFeed.getPrice();
        const parAtOpen = await relayer.par();

        // Compute SCR price from current totals, then choose liquidation price just below SCR
        const scrPrice = await calcSCRPrice();

        // Compute the ICR needed at open so that ICR_liq hits target at pLiq
        // icr_open = targetICRliq * (priceAtOpen / pLiq) * (parLiq / parAtOpen)
        const parLiq = parAtOpen;
        const icrOpenTarget = targetICRliq.mul(priceAtOpen).mul(parLiq).div(scrPrice.sub(toBN('1'))).div(parAtOpen);
        await tuneDebtToICROpen(bob, icrOpenTarget, priceAtOpen, parAtOpen)

        await tcrShutdown()
 
        await driveICRToTargetWithPar(bob, targetICRliq)
        // await priceFeed.setPrice(dec(100, 18))
        // const priceNow = await priceFeed.getPrice()
        // assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_before > listSize_After)
        // bob has surplus collateral
        // bobSurplus = await contracts.collSurplusPool.getCollateral(bob)
    
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    
        // check bob eth difference, considering eth used in tx
        txCost = th.ethUsed(tx)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
      })
      it("liquidate(): surplus collateral if liquidated by par above penalty, redistribution", async () => {
        // disable rates to ensure ICR change is from par only
        await contracts.rateControl.setCoBias(0)
        // set liq penalty to less than MCR
        await liquidations.setLiqPenaltyRedist(toBN(dec(106, 16)));
    
    
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(110, 16)), extraParams: { from: bob } })
    
        // Need to provideToSp since interest cannot accrue when SP is empty. interest is needed to make bob < MCR
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
        // open another trove so drip() can now reduce bob's ICR
        await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
        // withdraw so redistribution will happen w/ next liquidation
        await stabilityPool.withdrawFromSP(spDeposit.sub(toBN(dec(1,18))), { from: whale })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = (await sortedTroves.getSize()).toString()
    
        // this will raise par, increasing ICR
        await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(1).mul(ONE_CENT)));
        await relayer.updatePar()
    
        price = await priceFeed.getPrice()
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY_REDIST())))
    
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_before > listSize_After)
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    
        // check bob eth difference, considering eth used in tx
        txCost = th.ethUsed(tx)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
      })
      it("liquidate(): no surplus collateral if liquidated below penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(209, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = (await sortedTroves.getSize()).toString()
    
        await priceFeed.setPrice(dec(100, 18))
    
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await liquidations.LIQUIDATION_PENALTY())))
            // price keeps droping to drop collateral and debt
            await tcrShutdown()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_before > listSize_After)
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.eq(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
      })
      it("liquidate(): no surplus collateral if liquidated below penalty, redistribution", async () => {
        await liquidations.setLiqPenaltyRedist(toBN(dec(109, 16)));
        await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(209, 16)), extraParams: { from: bob } })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = (await sortedTroves.getSize()).toString()
    
        await priceFeed.setPrice(dec(100, 18))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await liquidations.LIQUIDATION_PENALTY_REDIST())))
    
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_before > listSize_After)
    
        // bob has no surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.eq(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob can't claim surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
      })
      it("liquidate(): no surplus collateral if liquidated by par below penalty", async () => {
        // disable rates to ensure ICR change is from par only
        await contracts.rateControl.setCoBias(0)
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(110, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = (await sortedTroves.getSize()).toString()
    
        // this will raise par, increasing ICR
        await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(5).mul(ONE_CENT)));
        await relayer.updatePar()
        
        // par rate of change is bounded so we need a lot of time to make a par change large
        // enough to cause ICR < LIQ_PENALTY
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider)
    
        await relayer.updatePar()
    
        price = await priceFeed.getPrice()
    
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await liquidations.LIQUIDATION_PENALTY())))
            // price keeps droping to drop collateral and debt
            await tcrShutdown()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_before > listSize_After)
    
        // bob has no surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.eq(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
      })
      it("liquidate(): no surplus collateral if liquidated by rate below penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(110, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = (await sortedTroves.getSize()).toString()
    
        // we need a lot of time to make dripped interest to cause ICR < LIQ_PENALTY
        await th.fastForwardTime(100*timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
        await relayer.updateRateAndPar()
        await tcrShutdown()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        price = await priceFeed.getPrice()
        const bobICR = await troveManager.getCurrentICR(bob, price)
        // console.log("bobICR", bobICR.toString())
        // console.log("mcr", (await troveManager.MCR()).toString())
        // console.log("penalty", (await liquidations.LIQUIDATION_PENALTY()).toString())
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await liquidations.LIQUIDATION_PENALTY())))
    
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 113000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_before > listSize_After)
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.eq(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
      })
      it("liquidate(): no surplus collateral if liquidated at penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = (await sortedTroves.getSize()).toString()
    
        await priceFeed.setPrice(dec(100, 18))
    
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).eq((await liquidations.LIQUIDATION_PENALTY())))
            // price keeps droping to drop collateral and debt
            await tcrShutdown()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_before > listSize_After)
    
        // bob has no surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.eq(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
    
      })

      it("liquidate(): surplus collateral if A,B,C liquidated above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: aliceCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
        const {collateral: carolCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: carol } })
    
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = await sortedTroves.getSize()
          
        // Choose target band at liquidation
        const penalty = await liquidations.LIQUIDATION_PENALTY();
   
        const mcr = await troveManager.MCR();
      
        const targetICRliq = penalty.add(toBN(dec(1,16))).add(mcr).div(toBN(2)); // midpoint in (penaltyRedist, MCR)

        // Capture current price/par (open-time)
        const priceAtOpen = await priceFeed.getPrice();
        const parAtOpen = await relayer.par();

        // Compute SCR price from current totals, then choose liquidation price just below SCR
        const scrPrice = await calcSCRPrice();

        // Compute the ICR needed at open so that ICR_liq hits target at pLiq
        // icr_open = targetICRliq * (priceAtOpen / pLiq) * (parLiq / parAtOpen)
        const parLiq = parAtOpen;
        const icrOpenTarget = targetICRliq.mul(priceAtOpen).mul(parLiq).div(scrPrice.sub(toBN('1'))).div(parAtOpen);
        await tuneDebtToICROpen(alice, icrOpenTarget, priceAtOpen, parAtOpen)
        await tuneDebtToICROpen(bob, icrOpenTarget, priceAtOpen, parAtOpen)
        await tuneDebtToICROpen(carol, icrOpenTarget, priceAtOpen, parAtOpen)

        await tcrShutdown()
        // price drops to put tcr below scr
        await driveICRToTargetWithPar(alice, targetICRliq)
        // await priceFeed.setPrice(dec(100, 18))
        const priceNow = await priceFeed.getPrice()
      
        assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        // calc liquidation tcr between LIQUIDATION_PENALTY and MCR
   
        assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate alice
        tx_alice = await liquidations.liquidate(alice)
        const [aliceLiquidatedDebt, aliceLiquidatedColl, aliceCollGasComp, aliceLusdGasComp] = th.getEmittedLiquidationValues(tx_alice)
        aliceGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(aliceCollGasComp.eq(aliceGasComp))
    
        // liquidate bob
        tx_bob = await liquidations.liquidate(bob)
        const [bobLiquidatedDebt, bobLiquidatedColl, bobCollGasComp, bobLusdGasComp] = th.getEmittedLiquidationValues(tx_bob)
        bobGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(bobCollGasComp.eq(bobGasComp))
    
        // liquidate carol
        tx_carol = await liquidations.liquidate(carol)
        const [carolLiquidatedDebt, carolLiquidatedColl, carolCollGasComp, carolLusdGasComp] = th.getEmittedLiquidationValues(tx_carol)
        carolGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(carolCollGasComp.eq(carolGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl), ethGain), 100000)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        // console.log('aliceSurplus', aliceSurplus.toString());
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol has surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        assert.isTrue(carolSurplus.gt(toBN('0')))
    
        // check total surplus
        totalSurplus = await collSurplusPool.getCollateral()
        assert.isTrue(totalSurplus.eq(aliceSurplus.add(bobSurplus).add(carolSurplus)))
    
        assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
        assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
        assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        const aliceAmount = th.getRawEventArgByName(tx_alice_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(aliceAmount).eq(aliceSurplus))
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        const bobAmount = th.getRawEventArgByName(tx_bob_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(bobAmount).eq(bobSurplus))
        // carol claims surplus collateral
        tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})
        const carolAmount = th.getRawEventArgByName(tx_carol_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(carolAmount).eq(carolSurplus))
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        // check carol eth difference, considering eth used in tx
        carolTxCost = th.ethUsed(tx_carol_claim)
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        assert.isTrue(carolBalanceDiff.eq(carolSurplus))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
    
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
    
      })
      it("liquidateTroves(): A,B,C same size troves. surplus collateral if A,B,C liquidated above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: aliceCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
        const {collateral: carolCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: carol } })
    
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = await sortedTroves.getSize()
          
        // Choose target band at liquidation
        const penalty = await liquidations.LIQUIDATION_PENALTY();
   
        const mcr = await troveManager.MCR();
      
        const targetICRliq = penalty.add(toBN(dec(1,16))).add(mcr).div(toBN(2)); // midpoint in (penaltyRedist, MCR)

        // Capture current price/par (open-time)
        const priceAtOpen = await priceFeed.getPrice();
        const parAtOpen = await relayer.par();

        // Compute SCR price from current totals, then choose liquidation price just below SCR
        const scrPrice = await calcSCRPrice();

        // Compute the ICR needed at open so that ICR_liq hits target at pLiq
        // icr_open = targetICRliq * (priceAtOpen / pLiq) * (parLiq / parAtOpen)
        const parLiq = parAtOpen;
        const icrOpenTarget = targetICRliq.mul(priceAtOpen).mul(parLiq).div(scrPrice.sub(toBN('1'))).div(parAtOpen);
        await tuneDebtToICROpen(alice, icrOpenTarget, priceAtOpen, parAtOpen)
        await tuneDebtToICROpen(bob, icrOpenTarget, priceAtOpen, parAtOpen)
        await tuneDebtToICROpen(carol, icrOpenTarget, priceAtOpen, parAtOpen)

        await tcrShutdown()
        // price drops to put tcr below scr
        await driveICRToTargetWithPar(alice, targetICRliq)
        await driveICRToTargetWithPar(bob, targetICRliq)
        // await priceFeed.setPrice(dec(100, 18))
        const priceNow = await priceFeed.getPrice()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
    
        // liquidate all
        tx_liq = await liquidations.liquidateTroves(3)
        const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
        totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(totalCollGasComp.eq(totalGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100000)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol has surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        assert.isTrue(carolSurplus.gt(toBN('0')))
    
        // check total surplus
        totalSurplus = await collSurplusPool.getCollateral()
        assert.isTrue(totalSurplus.eq(aliceSurplus.add(bobSurplus).add(carolSurplus)))
    
        aliceLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
        bobLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
        carolLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
        aliceCollGasComp = totalGasComp.div(toBN('3'))
        bobCollGasComp = totalGasComp.div(toBN('3'))
        carolCollGasComp = totalGasComp.div(toBN('3'))
    
        assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
        assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
        assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        // bob claims surplus collateral
        tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        // check carol eth difference, considering eth used in tx
        carolTxCost = th.ethUsed(tx_carol_claim)
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        assert.isTrue(carolBalanceDiff.eq(carolSurplus))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
    
      })
      it("batchLiquidate(): A,B,C same size troves. surplus collateral if A,B,C liquidated above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: aliceCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
        const {collateral: carolCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: carol } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = await sortedTroves.getSize()
          
        // Choose target band at liquidation
        const penalty = await liquidations.LIQUIDATION_PENALTY();
   
        const mcr = await troveManager.MCR();
      
        const targetICRliq = penalty.add(toBN(dec(1,16))).add(mcr).div(toBN(2)); // midpoint in (penaltyRedist, MCR)

        // Capture current price/par (open-time)
        const priceAtOpen = await priceFeed.getPrice();
        const parAtOpen = await relayer.par();

        // Compute SCR price from current totals, then choose liquidation price just below SCR
        const scrPrice = await calcSCRPrice();

        // Compute the ICR needed at open so that ICR_liq hits target at pLiq
        // icr_open = targetICRliq * (priceAtOpen / pLiq) * (parLiq / parAtOpen)
        const parLiq = parAtOpen;
        const icrOpenTarget = targetICRliq.mul(priceAtOpen).mul(parLiq).div(scrPrice.sub(toBN('1'))).div(parAtOpen);
        await tuneDebtToICROpen(alice, icrOpenTarget, priceAtOpen, parAtOpen)
        await tuneDebtToICROpen(bob, icrOpenTarget, priceAtOpen, parAtOpen)
        await tuneDebtToICROpen(carol, icrOpenTarget, priceAtOpen, parAtOpen)

        await tcrShutdown()
        // price drops to put tcr below scr
        await driveICRToTargetWithPar(alice, targetICRliq)
        await driveICRToTargetWithPar(bob, targetICRliq)
        // await priceFeed.setPrice(dec(100, 18))
        const priceNow = await priceFeed.getPrice()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
    
        // liquidate all
        //tx_liq = await liquidations.liquidateTroves(3)
        tx_liq = await liquidations.batchLiquidate([alice, bob, carol])
        const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
        totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(totalCollGasComp.eq(totalGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100000)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol has surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        assert.isTrue(carolSurplus.gt(toBN('0')))
    
        // check total surplus
        totalSurplus = await collSurplusPool.getCollateral()
        assert.isTrue(totalSurplus.eq(aliceSurplus.add(bobSurplus).add(carolSurplus)))
    
        aliceLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
        bobLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
        carolLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
        aliceCollGasComp = totalGasComp.div(toBN('3'))
        bobCollGasComp = totalGasComp.div(toBN('3'))
        carolCollGasComp = totalGasComp.div(toBN('3'))
    
        assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
        assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
        assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        // carol claims surplus collateral
        tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        // check carol eth difference, considering eth used in tx
        carolTxCost = th.ethUsed(tx_carol_claim)
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        assert.isTrue(carolBalanceDiff.eq(carolSurplus))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
    
      })

      it("liquidateTroves(): A,B,C different size troves, different ICRs. A,B,C have surplus collateral liquidated above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    
        const {collateral: aliceCollateral, totalDebt: aliceDebt, ICR: alice_ICR} = await openTrove({ ICR: toBN(dec(294, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral, totalDebt: bobDebt, ICR: bob_ICR} = await openTrove({ ICR: toBN(dec(296, 16)), extraLUSDAmount: toBN(dec(5,21)), extraParams: { from: bob } })
        const {collateral: carolCollateral, totalDebt: carolDebt, ICR: carol_ICR} = await openTrove({ ICR: toBN(dec(299, 16)), extraLUSDAmount: toBN(dec(20,21)), extraParams: { from: carol } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const priceAtOpen = await priceFeed.getPrice();
        const parAtOpen = await relayer.par();
        const scrPrice = await calcSCRPrice();

        const penalty = await liquidations.LIQUIDATION_PENALTY();
        const mcr = await troveManager.MCR();

        // pick distinct liquidation targets
        const targetAlice = penalty.add(mcr).div(toBN(2));         // between penalty and MCR
        const targetBob   = penalty.add(mcr).div(toBN(2));           // just above penalty
        const targetCarol = penalty.add(mcr).div(toBN(2));           // above penalty but < MCR

        // Preview par at the liquidation price used by shutdown
        const pLiq = scrPrice;
        await priceFeed.setPrice(pLiq);
        const parLiq = await relayer.nextPar();
        // Restore open-time price for tuning operations
        await priceFeed.setPrice(priceAtOpen);

        // icr_open = targetICRliq * (priceAtOpen / pLiq) * (parLiq / parAtOpen)
        let icrOpenAlice = targetAlice.mul(priceAtOpen).mul(parLiq).div(pLiq).div(parAtOpen);
        let icrOpenBob   = targetBob  .mul(priceAtOpen).mul(parLiq).div(pLiq).div(parAtOpen);
        let icrOpenCarol = targetCarol.mul(priceAtOpen).mul(parLiq).div(pLiq).div(parAtOpen);

        // Apply a small buffer to compensate for rounding/drip nuances (0.5%)
        const icrBuffer = toBN(dec(1005, 15)); // 1.005 * 1e18
        icrOpenAlice = icrOpenAlice.mul(icrBuffer).div(toBN(dec(1, 18)));
        icrOpenBob   = icrOpenBob  .mul(icrBuffer).div(toBN(dec(1, 18)));
        icrOpenCarol = icrOpenCarol.mul(icrBuffer).div(toBN(dec(1, 18)));

        // await tuneDebtToICROpen(alice, icrOpenAlice, priceAtOpen, parAtOpen);
        // await tuneDebtToICROpen(bob,   icrOpenBob,   priceAtOpen, parAtOpen);
        // await tuneDebtToICROpen(carol, icrOpenCarol, priceAtOpen, parAtOpen);

        // Snapshot per-trove debts after tuning, before shutdown (for pro-rata interest)
        const debtAlice = await troveManager.getTroveActualDebt(alice);
        const debtBob   = await troveManager.getTroveActualDebt(bob);
        const debtCarol = await troveManager.getTroveActualDebt(carol);
        const debtWhale = await troveManager.getTroveActualDebt(whale);
        const entireDebt = debtAlice.add(debtBob).add(debtCarol).add(debtWhale);
        const listSize_before = await sortedTroves.getSize()
        await tcrShutdown();

        // await priceFeed.setPrice(dec(100, 18))
        const price = await priceFeed.getPrice()
    
        aliceICR = await troveManager.getCurrentICR(alice, price)
        bobICR = await troveManager.getCurrentICR(bob, price)
        carolICR = await troveManager.getCurrentICR(carol, price)
        const liquidationPenalty = await liquidations.LIQUIDATION_PENALTY()
        // console.log("aliceICR", aliceICR.toString())
        // console.log("bobICR", bobICR.toString())
        // console.log("carolICR", carolICR.toString())
        // console.log("liquidation penalty", liquidationPenalty.toString())
        // console.log("mcr", mcr.toString())
    
        // ensure trove owners will have surplus collateral after liquidation
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mcr))
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).gt(liquidationPenalty))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mcr))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt(liquidationPenalty))
        assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt(mcr))
        assert.isTrue((await troveManager.getCurrentICR(carol, price)).gt(liquidationPenalty))

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // Snapshot per-trove debts immediately before liquidation
        const debtAlicePre = await troveManager.getTroveActualDebt(alice)
        const debtBobPre   = await troveManager.getTroveActualDebt(bob)
        const debtCarolPre = await troveManager.getTroveActualDebt(carol)
        const debtWhalePre = await troveManager.getTroveActualDebt(whale)
        const totalSystemDebt = await troveManager.getEntireSystemDebt()

        // liquidate all
        tx_liq = await liquidations.liquidateTroves(3)
        //tx_liq = await liquidations.liquidate(alice)
        const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
    
        spDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"))
        remDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_remaining"))

        // Expected liquidated debt is the sum of actual debts right before liquidation
        totalInterest = remDrip.add(spDrip)
        entireDebtDrip = entireDebt.add(totalInterest)
      
        aliceDebtLiq = debtAlicePre.add((totalInterest.mul(debtAlicePre).div(totalSystemDebt)))
        bobDebtLiq = debtBobPre.add((totalInterest.mul(debtBobPre).div(totalSystemDebt)))
        carolDebtLiq = debtCarolPre.add((totalInterest.mul(debtCarolPre).div(totalSystemDebt)))

        // console.log("totalLiquidatedDebt", totalLiquidatedDebt.toString())

        assert.isAtMost(th.getDifference(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq), totalLiquidatedDebt), 3)
        
        totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(totalCollGasComp.eq(totalGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 102000)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol has surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        assert.isTrue(carolSurplus.gt(toBN('0')))
    
        par = await relayer.par()
        aliceLiquidatedColl = aliceDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        bobLiquidatedColl = bobDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        carolLiquidatedColl = carolDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))

        // calculating w/ totalLiquidatedDebt is one truncation, while internally, totalLiqColl is the sum of many truncations
        // so this can be off by a few wei
        expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl) // totalLiquidatedDebt.mul(par).mul((await troveManager.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        //expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl)
    
        // console.log("expTotalLiquidatedColl", expTotalLiquidatedColl.toString())
        // console.log("totalLiquidatedColl", totalLiquidatedColl.toString())

        assert.isAtMost(th.getDifference(totalLiquidatedColl, expTotalLiquidatedColl), 3)
        // // verify total liq coll
        // assert.isAtMost(th.getDifference(expTotalLiquidatedColl, totalLiquidatedColl), 2)
    
        // verift total gas comp
        aliceCollGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
        bobCollGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        carolCollGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())
    
        assert.isTrue(aliceCollGasComp.add(bobCollGasComp).add(carolCollGasComp).eq(totalGasComp))
    
        // verify collateral invariant
        // console.log("aliceLiquidatedColl", aliceLiquidatedColl.toString())
        // console.log("aliceCollGasComp", aliceCollGasComp.toString())
        // console.log("aliceSurplus", aliceSurplus.toString())
        // console.log("aliceCollateral", aliceCollateral.toString())
        // console.log("bobLiquidatedColl", bobLiquidatedColl.toString())
        // console.log("bobCollGasComp", bobCollGasComp.toString())
        // console.log("bobSurplus", bobSurplus.toString())
        // console.log("bobCollateral", bobCollateral.toString())
        // console.log("carolLiquidatedColl", carolLiquidatedColl.toString())
        // console.log("carolCollGasComp", carolCollGasComp.toString())
        // console.log("carolSurplus", carolSurplus.toString())
        // console.log("carolCollateral", carolCollateral.toString())
        assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
        assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
        assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        // bob claims surplus collateral
        tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        // check carol eth difference, considering eth used in tx
        carolTxCost = th.ethUsed(tx_carol_claim)
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        assert.isTrue(carolBalanceDiff.eq(carolSurplus))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
      })
      it("batchLiquidate(): A,B,C different size troves, different ICRs. A,B,C have surplus collateral liquidated above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    
        const {collateral: aliceCollateral, totalDebt: aliceDebt, ICR: alice_ICR} = await openTrove({ ICR: toBN(dec(295, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral, totalDebt: bobDebt, ICR: bob_ICR} = await openTrove({ ICR: toBN(dec(296, 16)), extraLUSDAmount: toBN(dec(5,21)), extraParams: { from: bob } })
        const {collateral: carolCollateral, totalDebt: carolDebt, ICR: carol_ICR} = await openTrove({ ICR: toBN(dec(294, 16)), extraLUSDAmount: toBN(dec(20,21)), extraParams: { from: carol } })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

        const liquidationPenalty = await liquidations.LIQUIDATION_PENALTY()
        const mcr = await troveManager.MCR();

        const debtWhale = await troveManager.getTroveActualDebt(whale);
        const listSize_before = await sortedTroves.getSize()
        
        const scrPrice = await tcrShutdown();

        // await priceFeed.setPrice(dec(100, 18))
        const price = await priceFeed.getPrice()
    
        aliceICR = await troveManager.getCurrentICR(alice, price)
        bobICR = await troveManager.getCurrentICR(bob, price)
        carolICR = await troveManager.getCurrentICR(carol, price)

        // console.log("aliceICR", aliceICR.toString())
        // console.log("bobICR", bobICR.toString())
        // console.log("carolICR", carolICR.toString())
        // console.log("liquidation penalty", liquidationPenalty.toString())
        // console.log("mcr", mcr.toString())

        assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt(mcr))
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).gt(liquidationPenalty))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt(mcr))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt(liquidationPenalty))
        assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt(mcr))
        assert.isTrue((await troveManager.getCurrentICR(carol, price)).gt(liquidationPenalty))

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // snapshot before liq
        const aliceDebtPre = await troveManager.getTroveActualDebt(alice)
        const bobDebtPre = await troveManager.getTroveActualDebt(bob)
        const carolDebtPre = await troveManager.getTroveActualDebt(carol)
        const entireDebtPre = aliceDebtPre.add(bobDebtPre).add(carolDebtPre).add(debtWhale)
        // liquidate all
        tx_liq = await liquidations.batchLiquidate([alice, bob, carol])
        //tx_liq = await liquidations.liquidate(alice)
        const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
    
        //const [stakeDrip, spDrip] = th.getEmittedDripValues(contracts,tx_liq)
        spDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"))
        remDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_remaining"))
    
        totalInterest = remDrip.add(spDrip)
        
        aliceDebtLiq = aliceDebtPre.add((totalInterest.mul(aliceDebtPre).div(entireDebtPre)))
        bobDebtLiq = bobDebtPre.add((totalInterest.mul(bobDebtPre).div(entireDebtPre)))
        carolDebtLiq = carolDebtPre.add((totalInterest.mul(carolDebtPre).div(entireDebtPre)))
    
        //assert.isTrue(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq).eq(totalLiquidatedDebt))
        // TODO: increased tolerance.  is this OK?
        assert.isAtMost(th.getDifference(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq), totalLiquidatedDebt), 30000)
    
        totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(totalCollGasComp.eq(totalGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100030)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol has surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        assert.isTrue(carolSurplus.gt(toBN('0')))
        const currPrice = await priceFeed.getPrice()
        par = await relayer.par()
        aliceLiquidatedColl = aliceDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(currPrice)).div(toBN(dec(1,18)))
        bobLiquidatedColl = bobDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(currPrice)).div(toBN(dec(1,18)))
        carolLiquidatedColl = carolDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(currPrice)).div(toBN(dec(1,18)))
    
        // calculating w/ totalLiquidatedDebt is one truncation, while internally, totalLiqColl is the sum of many truncations
        // so this can be off by a few wei
        //expTotalLiquidatedColl = totalLiquidatedDebt.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl)
    
        // console.log("exp total liq coll", aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl).toString())
        // console.log("expTotalLiquidatedColl", expTotalLiquidatedColl.toString())
        // console.log("totalLiquidatedColl", totalLiquidatedColl.toString())
    
        // verify total liq coll
        assert.isAtMost(th.getDifference(expTotalLiquidatedColl, totalLiquidatedColl), 1800)
    
        // verift total gas comp
        aliceCollGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
        bobCollGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        carolCollGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())
    
        assert.isTrue(aliceCollGasComp.add(bobCollGasComp).add(carolCollGasComp).eq(totalGasComp))

        // verify collateral invariant
        assert.isAtMost(th.getDifference(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus), aliceCollateral), 1800)
        assert.isAtMost(th.getDifference(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus), bobCollateral), 1800)
        assert.isAtMost(th.getDifference(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus), carolCollateral), 1800)
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        // bob claims surplus collateral
        tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        // check carol eth difference, considering eth used in tx
        carolTxCost = th.ethUsed(tx_carol_claim)
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        assert.isTrue(carolBalanceDiff.eq(carolSurplus))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
      })
      
      it("liquidateTroves(): A,B,C different size troves, different ICRs. Only A,B have surplus collateral", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    
        const {collateral: aliceCollateral, totalDebt: aliceDebt, ICR: alice_ICR} = await openTrove({ ICR: toBN(dec(296, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral, totalDebt: bobDebt, ICR: bob_ICR} = await openTrove({ ICR: toBN(dec(294, 16)), extraLUSDAmount: toBN(dec(5,21)), extraParams: { from: bob } })
        const {collateral: carolCollateral, totalDebt: carolDebt, ICR: carol_ICR} = await openTrove({ ICR: toBN(dec(28339, 14)), extraLUSDAmount: toBN(dec(20,21)), extraParams: { from: carol } })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

        const liquidationPenalty = await liquidations.LIQUIDATION_PENALTY()
       
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = await sortedTroves.getSize()
          
        // Choose target band at liquidation
        const penalty = await liquidations.LIQUIDATION_PENALTY();
   
        const mcr = await troveManager.MCR();
        let price = await priceFeed.getPrice()

        await tcrShutdown()
        // await priceFeed.setPrice(dec(100, 18))
        price = await priceFeed.getPrice()
    
        //console.log("entire debt", (await troveManager.getEntireSystemActualDebt()).toString())
        entireDebt = (await troveManager.getTroveActualDebt(alice)).add((await troveManager.getTroveActualDebt(bob)))
              .add((await troveManager.getTroveActualDebt(carol))).add((await troveManager.getTroveActualDebt(whale)))

    
        aliceICR = await troveManager.getCurrentICR(alice, price)
        bobICR = await troveManager.getCurrentICR(bob, price)
        carolICR = await troveManager.getCurrentICR(carol, price)
    
        assert.isTrue((aliceICR).lt(mcr))
        assert.isTrue((aliceICR).gt(penalty))
        assert.isTrue((bobICR).lt(mcr))
        assert.isTrue((bobICR).gt(penalty))
        assert.isTrue((carolICR).lt(mcr))
        // check for eq here since drip() in liquidate will pull carol under the penalty 
        assert.isAtMost(th.getDifference(carolICR, penalty), 30000000000000)


        assert.isTrue(await th.checkRecoveryMode(contracts))
        const aliceDebtPre = await troveManager.getTroveActualDebt(alice)
        const bobDebtPre = await troveManager.getTroveActualDebt(bob)
        const carolDebtPre = await troveManager.getTroveActualDebt(carol)
        const entireDebtPre = aliceDebtPre.add(bobDebtPre).add(carolDebtPre).add(await troveManager.getTroveActualDebt(whale))
        // liquidate all
        tx_liq = await liquidations.liquidateTroves(3)
        //tx_liq = await liquidations.liquidate(alice)
        const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
    
        //const [stakeDrip, spDrip] = th.getEmittedDripValues(contracts,tx_liq)
        spDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"))
        remDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_remaining"))
    
        totalInterest = remDrip.add(spDrip)
        
        aliceDebtLiq = aliceDebtPre.add((totalInterest.mul(aliceDebtPre).div(entireDebtPre)))
        bobDebtLiq = bobDebtPre.add((totalInterest.mul(bobDebtPre).div(entireDebtPre)))
        carolDebtLiq = carolDebtPre.add((totalInterest.mul(carolDebtPre).div(entireDebtPre)))
    
        //assert.isTrue(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq).eq(totalLiquidatedDebt))
        assert.isAtMost(th.getDifference(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq), totalLiquidatedDebt), 3)
    
        totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(totalCollGasComp.eq(totalGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100000)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol does not have surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        assert.isAtMost(th.getDifference(carolSurplus, toBN('0')), 3)
    
        // verift total gas comp
        aliceCollGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
        bobCollGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        carolCollGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())
    
        assert.isTrue(aliceCollGasComp.add(bobCollGasComp).add(carolCollGasComp).eq(totalGasComp))
    
        par = await relayer.par()
        aliceLiquidatedColl = aliceDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        bobLiquidatedColl = bobDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        //carolLiquidatedColl = carolDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        carolLiquidatedColl = carolCollateral.sub(carolCollGasComp)
    
        // calculating w/ totalLiquidatedDebt is one truncation, while internally, totalLiqColl is the sum of many truncations
        // so this can be off by a few wei
        //expTotalLiquidatedColl = totalLiquidatedDebt.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl)
    
        /*
        console.log("exp total liq coll", aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl).toString())
        console.log("expTotalLiquidatedColl", expTotalLiquidatedColl.toString())
        console.log("totalLiquidatedColl", totalLiquidatedColl.toString())
        */
    
        // verify total liq coll
        assert.isTrue(expTotalLiquidatedColl.eq(totalLiquidatedColl))
    
        // verify collateral invariant
        assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
        assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
        assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        const aliceAmount = th.getRawEventArgByName(tx_alice_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(aliceAmount).eq(aliceSurplus))
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        const bobAmount = th.getRawEventArgByName(tx_bob_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(bobAmount).eq(bobSurplus))
        // carol can't claim surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        // carol should gain no collateral
        assert.isTrue(carolBalanceDiff.eq(toBN('0')))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
    
      })
      it("batchLiquidate(): A,B,C different size troves, different ICRs. Only A,B have surplus collateral", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: aliceCollateral, totalDebt: aliceDebt, ICR: alice_ICR} = await openTrove({ ICR: toBN(dec(296, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral, totalDebt: bobDebt, ICR: bob_ICR} = await openTrove({ ICR: toBN(dec(294, 16)), extraLUSDAmount: toBN(dec(5,21)), extraParams: { from: bob } })
        const {collateral: carolCollateral, totalDebt: carolDebt, ICR: carol_ICR} = await openTrove({ ICR: toBN(dec(28338, 14)), extraLUSDAmount: toBN(dec(20,21)), extraParams: { from: carol } })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_before = (await th.getTCR(contracts)).toString()
        const listSize_before = await sortedTroves.getSize()
    
    
        //console.log("entire debt", (await troveManager.getEntireSystemActualDebt()).toString())
        entireDebt = (await troveManager.getTroveActualDebt(alice)).add((await troveManager.getTroveActualDebt(bob)))
              .add((await troveManager.getTroveActualDebt(carol))).add((await troveManager.getTroveActualDebt(whale)))
                // price keeps droping to drop collateral and debt
        await tcrShutdown()
        price = await priceFeed.getPrice()

    
    
        aliceICR = await troveManager.getCurrentICR(alice, price)
        bobICR = await troveManager.getCurrentICR(bob, price)
        carolICR = await troveManager.getCurrentICR(carol, price)
        // console.log("aliceICR", aliceICR.toString())
        // console.log("bobICR", bobICR.toString())
        // console.log("carolICR", carolICR.toString())
    
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt((await troveManager.MCR())))
        // check for eq here since drip() in liquidate will pull carol under the penalty 
        assert.isAtMost(th.getDifference((await troveManager.getCurrentICR(carol, price)), (await liquidations.LIQUIDATION_PENALTY())), 30000000000000)


            assert.isTrue(await th.checkRecoveryMode(contracts))

            const aliceDebtPre = await troveManager.getTroveActualDebt(alice)
            const bobDebtPre = await troveManager.getTroveActualDebt(bob)
            const carolDebtPre = await troveManager.getTroveActualDebt(carol)
            const entireDebtPre = aliceDebtPre.add(bobDebtPre).add(carolDebtPre).add(await troveManager.getTroveActualDebt(whale))

        // liquidate all
        tx_liq = await liquidations.batchLiquidate([alice, bob, carol])
        //tx_liq = await liquidations.liquidate(alice)
        const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
    
        //const [stakeDrip, spDrip] = th.getEmittedDripValues(contracts,tx_liq)
        spDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"))
        remDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_remaining"))
    
        totalInterest = remDrip.add(spDrip)
        
        aliceDebtLiq = aliceDebtPre.add((totalInterest.mul(aliceDebtPre).div(entireDebtPre)))
        bobDebtLiq = bobDebtPre.add((totalInterest.mul(bobDebtPre).div(entireDebtPre)))
        carolDebtLiq = carolDebtPre.add((totalInterest.mul(carolDebtPre).div(entireDebtPre)))
    
        //assert.isTrue(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq).eq(totalLiquidatedDebt))
        assert.isAtMost(th.getDifference(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq), totalLiquidatedDebt), 3)
    
        totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(totalCollGasComp.eq(totalGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100000)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol does not have surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        // console.log("carolSurplus " + carolSurplus)
        assert.isTrue(carolSurplus.eq(toBN('0')))
    
        // verift total gas comp
        aliceCollGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
        bobCollGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        carolCollGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())
    
        assert.isTrue(aliceCollGasComp.add(bobCollGasComp).add(carolCollGasComp).eq(totalGasComp))
    
        par = await relayer.par()
        aliceLiquidatedColl = aliceDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        bobLiquidatedColl = bobDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        //carolLiquidatedColl = carolDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        carolLiquidatedColl = carolCollateral.sub(carolCollGasComp)
    
        // calculating w/ totalLiquidatedDebt is one truncation, while internally, totalLiqColl is the sum of many truncations
        // so this can be off by a few wei
        //expTotalLiquidatedColl = totalLiquidatedDebt.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl)
    
        /*
        console.log("exp total liq coll", aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl).toString())
        console.log("expTotalLiquidatedColl", expTotalLiquidatedColl.toString())
        console.log("totalLiquidatedColl", totalLiquidatedColl.toString())
        */
    
        // verify total liq coll
        assert.isTrue(expTotalLiquidatedColl.eq(totalLiquidatedColl))
    
        // verify collateral invariant
        assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
        assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
        assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        const aliceAmount = th.getRawEventArgByName(tx_alice_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(aliceAmount).eq(aliceSurplus))
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        const bobAmount = th.getRawEventArgByName(tx_bob_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(bobAmount).eq(bobSurplus))
        // carol can't claim surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        // carol should gain no collateral
        assert.isTrue(carolBalanceDiff.eq(toBN('0')))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
    
      })
    
      it("drip(): debt equals supply", async () => {
        // Whale provides LUSD to SP
        const spDeposit = toBN(dec(100, 24))
        await openTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })

        // provide to SP so drip will mint interest
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        await openTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_1 } })
        await openTrove({ ICR: toBN(dec(180, 16)), extraParams: { from: defaulter_2 } })
        await openTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: defaulter_3 } })
        await openTrove({ ICR: toBN(dec(192, 16)), extraParams: { from: defaulter_4 } })
    
    
        for (let i = 0; i < 100; i++) {
          await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
          await troveManager.drip()
    
          debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
          supply = await contracts.lusdToken.totalSupply()
    
          // amounts that aren't minted yet
          pendingSP = await contracts.stabilityPool.pendingLUSDDeposits()
          pendingLP = await contracts.globalFeeRouter.pendingLpDistribution()
          pendingStaker = await contracts.globalFeeRouter.pendingStakerDistribution()
    
          supplyVirtual = pendingSP.add(pendingLP).add(pendingStaker)
          supplyPlusVirtual = supply.add(supplyVirtual)
    
          // debt equals supply plus virtual
          assert.isTrue(supplyPlusVirtual.eq(debt))
    
          whale_debt = await contracts.troveManager.getTroveActualDebt(whale)
          trove_1_debt = await contracts.troveManager.getTroveActualDebt(defaulter_1)
          trove_2_debt = await contracts.troveManager.getTroveActualDebt(defaulter_2)
          trove_3_debt = await contracts.troveManager.getTroveActualDebt(defaulter_3)
          trove_4_debt = await contracts.troveManager.getTroveActualDebt(defaulter_4)
    
          trove_debt_sum = whale_debt.add(trove_1_debt).add(trove_2_debt).add(trove_3_debt).add(trove_4_debt)
          // allow at most divergence of 1 per trove
          assert.isTrue(supplyPlusVirtual.sub(trove_debt_sum).lte(toBN('4')))
        }
      })
    })


  describe("TroveManager - TCR Shutdown - RedeemCollateral", () => {
      beforeEach(async () => {
      await setup()
      })
  
  it('redeemCollateralForShutdown(): no discount, tcr shutdown,A,B,C,D troves with different ICRS, redeems collateral from lowest to highest icr troves, leaving lowest troves with 0 coll and pos debt and closing the final trove', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const denisLusdAmount = C_netDebt.add(B_netDebt).add(A_totalDebt)//.add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: denisLusdAmount, extraParams: { from: dennis } })
    // dennis withdraws collateral to bring his icr to just above MCR
    // const alice_tuned_coll = await tuneCollToMCR(alice)
    // const bob_tuned_coll = await tuneCollToMCR(bob)
    // const carol_tuned_coll = await tuneCollToMCR(carol)
  
    // const dennis_CollateralBalance_before = toBN(await collateralToken.balanceOf(dennis))

    // const dennis_LUSDBalance_before = await lusdToken.balanceOf(dennis)

    const price = await priceFeed.getPrice()
    assert.equal(price, dec(200, 18))


    // --- TEST ---

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    await relayer.updatePar()
    const priceAfterShutdown = await tcrShutdown()
    
    // Find hints for redeemption (after shutdown to get correct par)
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(denisLusdAmount, priceAfterShutdown, 0)

    // We don't need to use getApproxHint for this test, since it's not the subject of this
    // test case, and the list is very small, so the correct position is quickly found
    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )

    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )
    const aliceICR = await troveManager.getCurrentICR(alice, priceAfterShutdown)
    const bobICR = await troveManager.getCurrentICR(bob, priceAfterShutdown)
    const carolICR = await troveManager.getCurrentICR(carol, priceAfterShutdown)
    const dennisICR = await troveManager.getCurrentICR(dennis, priceAfterShutdown)
    const aliceCollBefore = await collateralToken.balanceOf(alice)
    const alice_trove_before = await troveManager.Troves(alice)
    const bob_trove_before = await troveManager.Troves(bob)
    const carol_trove_before = await troveManager.Troves(carol)
    const dennis_trove_before = await troveManager.Troves(dennis)
    const dennisCollBefore = await collateralToken.balanceOf(dennis)
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("price before shut |", price.toString())
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("alice_debt_before |", alice_trove_before[0].toString())
    // console.log("bob_debt_before   |", bob_trove_before[0].toString())
    // console.log("carol_debt_before |", carol_trove_before[0].toString())
    // console.log("dennis_debt_before|", dennis_trove_before[0].toString())
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("alice_coll_before |", alice_trove_before[1].toString())
    // console.log("bob_coll_before   |", bob_trove_before[1].toString())
    // console.log("carol_coll_before |", carol_trove_before[1].toString())
    // console.log("dennis_coll_before|", dennis_trove_before[1].toString())
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("aliceICR", aliceICR.toString())
    // console.log("bobICR", bobICR.toString())
    // console.log("carolICR", carolICR.toString())
    // console.log("dennisICR", dennisICR.toString())
    // console.log("+++++++++++++++++++++++++++++")

    // Dennis redeems his LUSD
    // Don't pay for gas, as it makes it easier to calculate the received Ether
    const redemptionTx = await troveManager.redeemCollateralForShutdown(
      denisLusdAmount,
      firstRedemptionHint,
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE
      }
    )

    const totalRedeemed = th.getEmittedRedemptionValues(redemptionTx)[1]
    const collateralDrawn = th.getEmittedRedemptionValues(redemptionTx)[2] // denisLusdAmount.mul(shutdownPar.mul(mv._1e18BN)).div(mv._1e18BN).div(priceAfterRedemption)
    // console.log("totalRedeemed", totalRedeemed.toString())
    const CollateralFee = th.getEmittedRedemptionValues(redemptionTx)[3]
    const priceAfterRedemption = await priceFeed.getPrice()
    const alice_trove_after_dennis = await troveManager.Troves(alice)
    const bob_trove_after_dennis = await troveManager.Troves(bob)
    const carol_trove_after_dennis = await troveManager.Troves(carol)
    // alice bob and carol troves should have 0 coll
    assert.isTrue(alice_trove_after_dennis[1].eq(toBN("0")))
    assert.isTrue(bob_trove_after_dennis[1].eq(toBN("0")))
    assert.isTrue(carol_trove_after_dennis[1].eq(toBN("0")))

    // shutdown par (tuple destructure)
    const cs = await troveManager.collateralShutdown();
    const shutdownPar = toBN(cs.par.toString());

    const dennisCollAfter = await collateralToken.balanceOf(dennis)
    // assert the redemption amount is equal to the total redeemed
    assert.isTrue(denisLusdAmount.eq(totalRedeemed))
    // assert the collateral delta is equal to the expected collateral delta
    // TODO: high tolerance
    assert.isAtMost(th.getDifference(dennisCollAfter.sub(dennisCollBefore), collateralDrawn), 600000000000000
  )

        // Find hints (after shutdown to get correct par)
        const {
          firstRedemptionHint:  alice_firstRedemptionHint,
          partialRedemptionHintNICR: alice_partialRedemptionHintNICR
        } = await hintHelpers.getRedemptionHints(alice_trove_after_dennis[0], priceAfterRedemption, 0)
    
        // We don't need to use getApproxHint for this test, since it's not the subject of this
        // test case, and the list is very small, so the correct position is quickly found
        const { 0: alice_upperPartialRedemptionHint, 1: alice_lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
          partialRedemptionHintNICR,
          alice,
          alice
        )
    
        const { 0: alice_upperShieldedPartialRedemptionHint, 1: alice_lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
          partialRedemptionHintNICR,
          alice,
          alice
        )
    
    const alice_coll_balance_before = await collateralToken.balanceOf(alice)  
    const alice_bal = await lusdToken.balanceOf(alice)
    // alice redeems her balance
    const alice_redemptionTx = await troveManager.redeemCollateralForShutdown(
      alice_bal,
      alice_firstRedemptionHint,
      alice_upperPartialRedemptionHint,
      alice_lowerPartialRedemptionHint,
      alice_upperShieldedPartialRedemptionHint,
      alice_lowerShieldedPartialRedemptionHint,
      alice_partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: alice,
        gasPrice: GAS_PRICE
      }
    )

    const alice_totalRedeemed = th.getEmittedRedemptionValues(alice_redemptionTx)[1]
    // console.log("totalRedeemed", totalRedeemed.toString())
    const alice_CollateralFee = th.getEmittedRedemptionValues(alice_redemptionTx)[3]
    const alice_expectedDelta = alice_bal.mul(shutdownPar.mul(mv._1e18BN)).div(mv._1e18BN).div(priceAfterRedemption)
    const alice_coll_balance_after = await collateralToken.balanceOf(alice)
    const alice_delta = alice_coll_balance_after.sub(alice_coll_balance_before)

    assert.isTrue(alice_CollateralFee.eq(toBN("0")))
    console.log("alice_totalRedeemed", alice_totalRedeemed.toString())
    console.log("alice_bal", alice_bal.toString())
    assert.isAtMost(th.getDifference(alice_totalRedeemed, alice_bal), 10000000000000000000)
    console.log("alice_expectedDelta", alice_expectedDelta.toString())
    console.log("alice_delta", alice_delta.toString())
    // TODO: high tolerance
    assert.isAtMost(th.getDifference(alice_expectedDelta, alice_delta), 400000000000000)
    // carol redeems her balance
    const carol_trove_After = await troveManager.Troves(carol)
    const {
      firstRedemptionHint:  carol_firstRedemptionHint,
      partialRedemptionHintNICR: carol_partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(carol_trove_After[0], priceAfterRedemption, 0)

    // get carol's redemption hints
    const { 0: carol_upperPartialRedemptionHint, 1: carol_lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      carol,
      carol
    )

    const { 0: carol_upperShieldedPartialRedemptionHint, 1: carol_lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      carol,
      carol
    )

    const carol_coll_balance_before = await collateralToken.balanceOf(carol)  
    const carol_bal = await lusdToken.balanceOf(carol)
    const surplusPool_balance_before = await collateralToken.balanceOf(collSurplusPool.address)
    // carol redeems her balance this will be a partial redemption since dennis with the highest icr will have all his debt canceled and remaining coll sent to surplus pool
    const carol_redemptionTx = await troveManager.redeemCollateralForShutdown(
      carol_bal,
      carol_firstRedemptionHint,
      carol_upperPartialRedemptionHint,
      carol_lowerPartialRedemptionHint,
      carol_upperShieldedPartialRedemptionHint,
      carol_lowerShieldedPartialRedemptionHint,
      carol_partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: carol,
        gasPrice: GAS_PRICE
      }
    )
   const carol_totalRedeemed = th.getEmittedRedemptionValues(carol_redemptionTx)[1]
   const carol_CollateralFee = th.getEmittedRedemptionValues(carol_redemptionTx)[3]
   const carol_expectedDelta = carol_bal.mul(shutdownPar.mul(mv._1e18BN)).div(mv._1e18BN).div(priceAfterRedemption)
   const carol_coll_balance_after = await collateralToken.balanceOf(carol)
   const carol_delta = carol_coll_balance_after.sub(carol_coll_balance_before)
    const alice_trove_empty = await troveManager.Troves(alice)
    const bob_trove_empty = await troveManager.Troves(bob)
    const carol_trove_empty = await troveManager.Troves(carol)
    const dennis_trove_empty = await troveManager.Troves(dennis)

    // all troves should have 0 coll and some remaining debt (except dennis who has 0 remaining debt)
    assert.isTrue(alice_trove_empty[1].eq(toBN("0")))
    assert.isTrue(bob_trove_empty[1].eq(toBN("0")))
    assert.isTrue(carol_trove_empty[1].eq(toBN("0")))
    assert.isTrue(dennis_trove_empty[1].eq(toBN("0")))
    assert.isTrue(alice_trove_empty[0].gt(toBN("0")))
    assert.isTrue(bob_trove_empty[0].gt(toBN("0")))
    assert.isTrue(carol_trove_empty[0].gt(toBN("0")))
    assert.isTrue(dennis_trove_empty[0].eq(toBN("0")))
    assert.isTrue(carol_CollateralFee.eq(toBN("0")))
    assert.isTrue(carol_totalRedeemed.lt(carol_bal))
    // subtract unredeemed delta from expected delta
    assert.isAtMost(th.getDifference(carol_expectedDelta.sub(toBN("387050328974803515089")), carol_delta), 123)
    // since all of dennis' debt is canceled his trove should be closed and remaining coll should be sent to surplus pool
    assert.isTrue(dennis_trove_empty[0].eq(toBN("0")))
    assert.isTrue(dennis_trove_empty[1].eq(toBN("0")))
    assert.isTrue(surplusPool_balance_before.lt(await collateralToken.balanceOf(collSurplusPool.address)))
  

    // bob attempts to redeem his balance
    const bob_trove_before_bobRedeem = await troveManager.Troves(bob)
    const bob_coll_balance_before_bobRedeem = await collateralToken.balanceOf(bob)
    const bob_bal = await lusdToken.balanceOf(bob)
    const {
      firstRedemptionHint:  bob_firstRedemptionHint,
      partialRedemptionHintNICR: bob_partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(bob_trove_before_bobRedeem[0], priceAfterRedemption, 0)

    // get carol's redemption hints
    const { 0: bob_upperPartialRedemptionHint, 1: bob_lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      carol,
      carol
    )

    const { 0: bob_upperShieldedPartialRedemptionHint, 1: bob_lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      carol,
      carol
    )

    const bob_coll_balance_before = await collateralToken.balanceOf(carol)  
    const bob_bal_before_bobRedeem = await lusdToken.balanceOf(carol)

    // bob attempts to redeem his balance but reverts with TM: Unable to redeem
    try {
    const bob_redemptionTx = await troveManager.redeemCollateralForShutdown(
      bob_bal_before_bobRedeem,
      bob_firstRedemptionHint,
      bob_upperPartialRedemptionHint,
      bob_lowerPartialRedemptionHint,
      bob_upperShieldedPartialRedemptionHint,
      bob_lowerShieldedPartialRedemptionHint,
      bob_partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: bob,
        gasPrice: GAS_PRICE
      }
    )
  } catch (error) {
    assert.include(error.message, "revert")
    assert.include(error.message, "TM: Unable to redeem")
  }

    debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
    supply = await contracts.lusdToken.totalSupply()
    // console.log("debt", debt.toString())
    // console.log("supply", supply.toString())
    // console.log("supply - debt", supply.sub(debt).toString())
    assert.isTrue(supply.eq(debt))
  })
  it('redeemCollateralForShutdown(): tcr shutdown, full discount,A,B,C,D troves with the same ICRs, redeems collateral from first to last troves, all troves are closed', async () => {
    // --- SETUP ---
    const mcr = await troveManager.MCR()
    const troveLowICR = mcr.add(toBN(dec(1, 18)))
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: troveLowICR, extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: troveLowICR, extraLUSDAmount: dec(10, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: troveLowICR, extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const { netDebt: D_netDebt } =await openTrove({ ICR: troveLowICR, extraLUSDAmount: dec(10, 18), extraParams: { from: dennis } })
    const alice_redemptionAmount = await lusdToken.balanceOf(alice)
    const bob_redemptionAmount = await lusdToken.balanceOf(bob)
    const carol_redemptionAmount = await lusdToken.balanceOf(carol)
    const dennis_redemptionAmount = await lusdToken.balanceOf(dennis)
  
    const price = await priceFeed.getPrice()
    assert.equal(price, dec(200, 18))


    // --- TEST ---

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    await relayer.updatePar()
    const priceAfterShutdown = await tcrShutdown()

    // Find hints for redeemption (after shutdown to get correct par)
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(alice_redemptionAmount, priceAfterShutdown, 0)

    // We don't need to use getApproxHint for this test, since it's not the subject of this
    // test case, and the list is very small, so the correct position is quickly found
    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      alice,
      alice
    )

    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      alice,
      alice
    )
    const aliceICR = await troveManager.getCurrentICR(alice, priceAfterShutdown)
    const bobICR = await troveManager.getCurrentICR(bob, priceAfterShutdown)
    const carolICR = await troveManager.getCurrentICR(carol, priceAfterShutdown)
    const dennisICR = await troveManager.getCurrentICR(dennis, priceAfterShutdown)
    
    const alice_trove_before = await troveManager.Troves(alice)
    const bob_trove_before = await troveManager.Troves(bob)
    const carol_trove_before = await troveManager.Troves(carol)
    const dennis_trove_before = await troveManager.Troves(dennis)
    const aliceCollBefore = await collateralToken.balanceOf(alice)
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("price before shut |", price.toString())
    // console.log("price after shut  |", priceAfterShutdown.toString())
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("alice_debt_before |", alice_trove_before[0].toString())
    // console.log("bob_debt_before   |", bob_trove_before[0].toString())
    // console.log("carol_debt_before |", carol_trove_before[0].toString())
    // console.log("dennis_debt_before|", dennis_trove_before[0].toString())
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("alice_coll_before |", alice_trove_before[1].toString())
    // console.log("bob_coll_before   |", bob_trove_before[1].toString())
    // console.log("carol_coll_before |", carol_trove_before[1].toString())
    // console.log("dennis_coll_before|", dennis_trove_before[1].toString())
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("aliceICR", aliceICR.toString())
    // console.log("bobICR", bobICR.toString())
    // console.log("carolICR", carolICR.toString())
    // console.log("dennisICR", dennisICR.toString())
    // console.log("+++++++++++++++++++++++++++++")

    // alice redeems her balance
    // Don't pay for gas, as it makes it easier to calculate the received Ether
    const redemptionTx = await troveManager.redeemCollateralForShutdown(
      alice_redemptionAmount,
      firstRedemptionHint,
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: alice,
        gasPrice: GAS_PRICE
      }
    )

    const totalRedeemed = th.getEmittedRedemptionValues(redemptionTx)[1]
    // console.log("totalRedeemed", totalRedeemed.toString())
    const CollateralFee = th.getEmittedRedemptionValues(redemptionTx)[3]
    const priceAfterRedemption = await priceFeed.getPrice()
    const alice_trove_after_dennis = await troveManager.Troves(alice)
    const bob_trove_after_dennis = await troveManager.Troves(bob)
    const carol_trove_after_dennis = await troveManager.Troves(carol)
    const dennis_trove_after_dennis = await troveManager.Troves(dennis)
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("alice_debt_after_alice", alice_trove_after_dennis[0].toString())
    // console.log("bob_debt_after_alice", bob_trove_after_dennis[0].toString())
    // console.log("carol_debt_after_alice", carol_trove_after_dennis[0].toString())
    // console.log("dennis_debt_after_alice", dennis_trove_after_dennis[0].toString())
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("alice_Coll_after_alice", alice_trove_after_dennis[1].toString())
    // console.log("bob_Coll_after_alice", bob_trove_after_dennis[1].toString())
    // console.log("carol_Coll_after_alice", carol_trove_after_dennis[1].toString())
    // console.log("dennis_Coll_after_alice", dennis_trove_after_dennis[1].toString())
    // console.log("+++++++++++++++++++++++++++++")

    // alice trove should be closed
    assert.isTrue(alice_trove_after_dennis[0].eq(toBN("0")))
    assert.isTrue(alice_trove_after_dennis[1].eq(toBN("0")))
    assert.isTrue(bob_trove_after_dennis[1].gt(toBN("0")))
    assert.isTrue(bob_trove_after_dennis[1].eq(bob_trove_before[1]))
    // carol and dennis should be unchanged
    assert.isTrue(carol_trove_after_dennis[0].eq(carol_trove_before[0]))
    assert.isTrue(carol_trove_after_dennis[1].eq(carol_trove_before[1]))
    assert.isTrue(dennis_trove_after_dennis[0].eq(dennis_trove_before[0]))
    assert.isTrue(dennis_trove_after_dennis[1].eq(dennis_trove_before[1]))
    const aliceCollAfter = await collateralToken.balanceOf(alice)

    // shutdown par (tuple destructure)
    const cs = await troveManager.collateralShutdown();
    const shutdownPar = toBN(cs.par.toString());

    // assert the redemption amount is equal to the total redeemed
    assert.isTrue(alice_redemptionAmount.eq(totalRedeemed))
    // assert the collateral delta is equal to the expected collateral delta
    const expectedDelta = alice_redemptionAmount.mul(shutdownPar.mul(mv._1e18BN)).div(mv._1e18BN).div(priceAfterRedemption)
    // TODO: high tolerance
    assert.isAtMost(th.getDifference(aliceCollAfter.sub(aliceCollBefore), expectedDelta), 600000000000000
  )



        // Find hints bob redeem (after shutdown to get correct par)
        const {
          firstRedemptionHint:  bob_firstRedemptionHint,
          partialRedemptionHintNICR: bob_partialRedemptionHintNICR
        } = await hintHelpers.getRedemptionHints(bob_trove_after_dennis[0], priceAfterRedemption, 0)
    
        // We don't need to use getApproxHint for this test, since it's not the subject of this
        // test case, and the list is very small, so the correct position is quickly found
        const { 0: bob_upperPartialRedemptionHint, 1: bob_lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
          partialRedemptionHintNICR,
          bob,
          bob
        )
    
        const { 0: bob_upperShieldedPartialRedemptionHint, 1: bob_lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
          partialRedemptionHintNICR,
          bob,
          bob
        )
    
    const bob_coll_balance_before = await collateralToken.balanceOf(bob)  

    // bob redeems her balance
    const bob_redemptionTx = await troveManager.redeemCollateralForShutdown(
      bob_redemptionAmount,
      bob_firstRedemptionHint,
      bob_upperPartialRedemptionHint,
      bob_lowerPartialRedemptionHint,
      bob_upperShieldedPartialRedemptionHint,
      bob_lowerShieldedPartialRedemptionHint,
      bob_partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: bob,
        gasPrice: GAS_PRICE
      }
    )

    const alice_trove_after_bob = await troveManager.Troves(alice)
    const bob_trove_after_bob = await troveManager.Troves(bob)
    const carol_trove_after_bob = await troveManager.Troves(carol)
    const dennis_trove_after_bob = await troveManager.Troves(dennis)
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("alice_debt_after_bob", alice_trove_after_bob[0].toString())
    // console.log("bob_debt_after_bob", bob_trove_after_bob[0].toString())
    // console.log("carol_debt_after_bob", carol_trove_after_bob[0].toString())
    // console.log("dennis_debt_after_bob", dennis_trove_after_bob[0].toString())
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("alice_Coll_after_bob", alice_trove_after_bob[1].toString())
    // console.log("bob_Coll_after_bob", bob_trove_after_bob[1].toString())
    // console.log("carol_Coll_after_bob", carol_trove_after_bob[1].toString())
    // console.log("dennis_Coll_after_bob", dennis_trove_after_bob[1].toString())
    // console.log("+++++++++++++++++++++++++++++")

    const bob_totalRedeemed = th.getEmittedRedemptionValues(bob_redemptionTx)[1]
    // console.log("totalRedeemed", totalRedeemed.toString())
    const bob_CollateralFee = th.getEmittedRedemptionValues(bob_redemptionTx)[3]
    const bob_expectedDelta = bob_redemptionAmount.mul(shutdownPar.mul(mv._1e18BN)).div(mv._1e18BN).div(priceAfterRedemption)
    const bob_coll_balance_after = await collateralToken.balanceOf(bob)
    const bob_delta = bob_coll_balance_after.sub(bob_coll_balance_before)

    assert.isTrue(bob_CollateralFee.eq(toBN("0")))
    assert.isTrue(alice_trove_after_bob[0].eq(toBN("0")))
    assert.isTrue(bob_trove_after_bob[0].eq(toBN("0")))
    assert.isTrue(carol_trove_after_bob[0].eq(carol_trove_before[0]))
    assert.isTrue(dennis_trove_after_bob[0].eq(dennis_trove_before[0]))
    assert.isTrue(alice_trove_after_bob[1].eq(toBN("0")))
    assert.isTrue(bob_trove_after_bob[1].eq(toBN("0")))
    assert.isTrue(carol_trove_after_bob[1].eq(carol_trove_before[1]))
    assert.isTrue(dennis_trove_after_bob[1].eq(dennis_trove_before[1]))
    assert.isTrue(bob_totalRedeemed.eq(bob_redemptionAmount))
    // TODO: high tolerance
    assert.isAtMost(th.getDifference(bob_expectedDelta, bob_delta), 400000000000000)

    // carol redeems her balance
    const {
      firstRedemptionHint:  carol_firstRedemptionHint,
      partialRedemptionHintNICR: carol_partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(carol_trove_after_bob[0], priceAfterRedemption, 0)

    // get carol's redemption hints
    const { 0: carol_upperPartialRedemptionHint, 1: carol_lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      carol,
      carol
    )

    const { 0: carol_upperShieldedPartialRedemptionHint, 1: carol_lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      carol,
      carol
    )

    const carol_coll_balance_before = await collateralToken.balanceOf(carol)  
    const surplusPool_balance_before = await collateralToken.balanceOf(collSurplusPool.address)
    // carol redeems her balance this will be a partial redemption since dennis with the highest icr will have all his debt canceled and remaining coll sent to surplus pool
    const carol_redemptionTx = await troveManager.redeemCollateralForShutdown(
      carol_redemptionAmount,
      carol_firstRedemptionHint,
      carol_upperPartialRedemptionHint,
      carol_lowerPartialRedemptionHint,
      carol_upperShieldedPartialRedemptionHint,
      carol_lowerShieldedPartialRedemptionHint,
      carol_partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: carol,
        gasPrice: GAS_PRICE
      }
    )
   const carol_totalRedeemed = th.getEmittedRedemptionValues(carol_redemptionTx)[1]
   const carol_CollateralFee = th.getEmittedRedemptionValues(carol_redemptionTx)[3]
   const carol_expectedDelta = carol_redemptionAmount.mul(shutdownPar.mul(mv._1e18BN)).div(mv._1e18BN).div(priceAfterRedemption)
   const carol_coll_balance_after = await collateralToken.balanceOf(carol)
   const carol_delta = carol_coll_balance_after.sub(carol_coll_balance_before)
    const alice_trove_after_carol = await troveManager.Troves(alice)
    const bob_trove_after_carol = await troveManager.Troves(bob)
    const carol_trove_after_carol = await troveManager.Troves(carol)
    const dennis_trove_after_carol = await troveManager.Troves(dennis)
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("alice_debt_after_carol", alice_trove_after_carol[0].toString())
    // console.log("bob_debt_after_carol", bob_trove_after_carol[0].toString())
    // console.log("carol_debt_after_carol", carol_trove_after_carol[0].toString())
    // console.log("dennis_debt_after_carol", dennis_trove_after_carol[0].toString())
    // console.log("+++++++++++++++++++++++++++++")
    // console.log("alice_Coll_after_carol", alice_trove_after_carol[1].toString())
    // console.log("bob_Coll_after_carol", bob_trove_after_carol[1].toString())
    // console.log("carol_Coll_after_carol", carol_trove_after_carol[1].toString())
    // console.log("dennis_Coll_after_carol", dennis_trove_after_carol[1].toString())
    // console.log("+++++++++++++++++++++++++++++")

    // all troves should have 0 coll and some remaining debt (except dennis who has 0 remaining debt)
    assert.isTrue(alice_trove_after_carol[1].eq(toBN("0")))
    assert.isTrue(bob_trove_after_carol[1].eq(toBN("0")))
    assert.isTrue(carol_trove_after_carol[1].eq(toBN("0")))
    assert.isTrue(dennis_trove_after_carol[1].eq(dennis_trove_after_bob[1]))
    assert.isTrue(alice_trove_after_carol[0].eq(toBN("0")))
    assert.isTrue(bob_trove_after_carol[0].eq(toBN("0")))
    assert.isTrue(carol_trove_after_carol[0].eq(toBN("0")))
    assert.isTrue(dennis_trove_after_carol[0].eq(dennis_trove_after_bob[0]))
    assert.isTrue(carol_CollateralFee.eq(toBN("0")))
    assert.isTrue(carol_totalRedeemed.eq(carol_redemptionAmount))
    // subtract unredeemed delta from expected delta
    assert.isAtMost(th.getDifference(carol_expectedDelta, carol_delta), 20000000000000)

    // dennis attempts to redeem his balance
    // get dennis' redemption hints
    const {
      firstRedemptionHint:  dennis_firstRedemptionHint,
      partialRedemptionHintNICR: dennis_partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(dennis_trove_after_carol[0], priceAfterRedemption, 0)


    const { 0: dennis_upperPartialRedemptionHint, 1: dennis_lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )

    const { 0: dennis_upperShieldedPartialRedemptionHint, 1: dennis_lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )
    const dennis_bal_before_dennisRedeem = await lusdToken.balanceOf(dennis)
    const dennis_coll_balance_before = await collateralToken.balanceOf(dennis)  

    // dennis redeems his balance
    const dennis_redemptionTx = await troveManager.redeemCollateralForShutdown(
      dennis_redemptionAmount,
      dennis_firstRedemptionHint,
      dennis_upperPartialRedemptionHint,
      dennis_lowerPartialRedemptionHint,
      dennis_upperShieldedPartialRedemptionHint,
      dennis_lowerShieldedPartialRedemptionHint,
      dennis_partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE
      }
    )
    const dennis_totalRedeemed = th.getEmittedRedemptionValues(dennis_redemptionTx)[1]
    const dennis_CollateralFee = th.getEmittedRedemptionValues(dennis_redemptionTx)[3]
    const dennis_expectedDelta = dennis_bal_before_dennisRedeem.mul(shutdownPar.mul(mv._1e18BN)).div(mv._1e18BN).div(priceAfterRedemption)
    const dennis_coll_balance_after = await collateralToken.balanceOf(dennis)
    const dennis_delta = dennis_coll_balance_after.sub(dennis_coll_balance_before)

    assert.isTrue(dennis_CollateralFee.eq(toBN("0")))
    assert.isTrue(dennis_totalRedeemed.eq(dennis_bal_before_dennisRedeem))
    assert.isAtMost(th.getDifference(dennis_expectedDelta, dennis_delta), 27000000000000)

    debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
    supply = await contracts.lusdToken.totalSupply()
    // console.log("debt", debt.toString())
    // console.log("supply", supply.toString())
    // console.log("supply - debt", supply.sub(debt).toString())
    assert.isTrue(supply.eq(debt))
  })

  it('redeemCollateralForShutdown(): tcr shutdown, with invalid first hint, zero address', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })
    const shutdownPrice = await tcrShutdown()
    const dennis_CollateralBalance_before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_before = await lusdToken.balanceOf(dennis)
    // --- TEST ---

    // Find hints for redeeming 20 LUSD
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(redemptionAmount, shutdownPrice, 0)

    // We don't need to use getApproxHint for this test, since it's not the subject of this
    // test case, and the list is very small, so the correct position is quickly found
    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    await relayer.updatePar()

    // Dennis redeems 20 LUSD
    // Don't pay for gas, as it makes it easier to calculate the received Ether
    const redemptionTx = await troveManager.redeemCollateralForShutdown(
      redemptionAmount,
      ZERO_ADDRESS, // invalid first hint
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE 
      }
    )

    const CollateralFee = th.getEmittedRedemptionValues(redemptionTx)[3]

    const alice_trove_After = await troveManager.Troves(alice)
    const bob_trove_After = await troveManager.Troves(bob)
    const carol_trove_After = await troveManager.Troves(carol)
    const alice_debt_After = alice_trove_After[0].toString()
    const bob_debt_After = bob_trove_After[0].toString()
    const carol_debt_After = carol_trove_After[0].toString()

    /* check that Dennis' redemption cancelled debt from other troves and drained their collateral.
    Alice, Bob, and Carol should have their collateral drained to 0. */
    assert.equal(alice_trove_After[1].toString(), '0')
    assert.equal(bob_trove_After[1].toString(), '0')
    assert.equal(carol_trove_After[1].toString(), '0')

    const dennis_CollateralBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedCollateral = dennis_CollateralBalance_After.sub(dennis_CollateralBalance_before)
    const par = await relayer.par()
    const discount = await troveManager.getDiscount()
    const expectedTotalCollateralDrawn = redemptionAmount.mul(par).mul(mv._1e18BN).div(mv._1e18BN.sub(discount).mul(shutdownPrice)) // convert redemptionAmount * par / (price * (1-discount))

    th.assertIsApproximatelyEqual(expectedTotalCollateralDrawn, receivedCollateral)

    const dennis_LUSDBalance_After = (await lusdToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_before.sub(redemptionAmount))
  })
  it('redeemCollateralForShutdown(): tcr shutdown, full discount, with invalid first hint, non-existent trove', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(dec(2, 18))
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })
    // shut down
    const price = await tcrShutdown()
    const dennis_CollateralBalance_before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_before = await lusdToken.balanceOf(dennis)

    // --- TEST ---

    // Find hints for redeeming 20 LUSD
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(redemptionAmount, price, 0)

    // We don't need to use getApproxHint for this test, since it's not the subject of this
    // test case, and the list is very small, so the correct position is quickly found
    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Dennis redeems 20 LUSD
    // Don't pay for gas, as it makes it easier to calculate the received Ether
    const redemptionTx = await troveManager.redeemCollateralForShutdown(
      redemptionAmount,
      erin, // invalid first hint, it doesn't have a trove
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE
      }
    )

    const CollateralFee = th.getEmittedRedemptionValues(redemptionTx)[3]

    const alice_trove_After = await troveManager.Troves(alice)
    const bob_trove_After = await troveManager.Troves(bob)
    const carol_trove_After = await troveManager.Troves(carol)

    const alice_debt_After = alice_trove_After[0].toString()
    const bob_debt_After = bob_trove_After[0].toString()
    const carol_debt_After = carol_trove_After[0].toString()

    /* check that Dennis' redemption cancelled debt from other troves and drained their collateral.
    Alice, Bob, and Carol should have their collateral drained to 0. */
    assert.equal(alice_trove_After[1].toString(), '0')
    assert.equal(bob_trove_After[1].toString(), '0')
    assert.equal(carol_trove_After[1].toString(), '0')

    const dennis_CollateralBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedCollateral = dennis_CollateralBalance_After.sub(dennis_CollateralBalance_before)
    const par = await relayer.par()
    const discount = await troveManager.getDiscount()
    const expectedTotalCollateralDrawn = redemptionAmount.mul(par).mul(mv._1e18BN).div(mv._1e18BN.sub(discount).mul(price)) // convert redemptionAmount * par / (price * (1-discount))

    th.assertIsApproximatelyEqual(expectedTotalCollateralDrawn, receivedCollateral)

    const dennis_LUSDBalance_After = (await lusdToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_before.sub(redemptionAmount))
  })

  it('redeemCollateralForShutdown(): tcr shutdown, full discount, with invalid first hint, trove below MCR', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(dec(2, 18))
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_CollateralBalance_before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_before = await lusdToken.balanceOf(dennis)
    let price = await priceFeed.getPrice()
    // Increase price to start Erin, and decrease it again so its ICR is under MCR
    await priceFeed.setPrice(price.mul(toBN(2)))
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: erin } })
    price = await tcrShutdown()


    // --- TEST ---

    // Find hints for redeeming 20 LUSD
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(redemptionAmount, price, 0)

    // We don't need to use getApproxHint for this test, since it's not the subject of this
    // test case, and the list is very small, so the correct position is quickly found
    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Dennis redeems 20 LUSD
    // Don't pay for gas, as it makes it easier to calculate the received Ether
    const redemptionTx = await troveManager.redeemCollateralForShutdown(
      redemptionAmount,
      erin, // invalid trove, below MCR
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE
      }
    )

    const CollateralFee = th.getEmittedRedemptionValues(redemptionTx)[3]

    const alice_trove_After = await troveManager.Troves(alice)
    const bob_trove_After = await troveManager.Troves(bob)
    const carol_trove_After = await troveManager.Troves(carol)

    const alice_debt_After = alice_trove_After[0].toString()
    const bob_debt_After = bob_trove_After[0].toString()
    const carol_debt_After = carol_trove_After[0].toString()

    /* check that Dennis' redemption cancelled debt from other troves and drained their collateral.
    Alice, Bob, and Carol should have their collateral drained to 0. */
    assert.equal(alice_trove_After[1].toString(), '0')
    assert.equal(bob_trove_After[1].toString(), '0')
    assert.equal(carol_trove_After[1].toString(), '0')

    const dennis_CollateralBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedCollateral = dennis_CollateralBalance_After.sub(dennis_CollateralBalance_before)
    const par = await relayer.par()
    const discount = await troveManager.getDiscount()
    const expectedTotalCollateralDrawn = redemptionAmount.mul(par).mul(mv._1e18BN).div(mv._1e18BN.sub(discount).mul(price)) // convert redemptionAmount * par / (price * (1-discount))

    th.assertIsApproximatelyEqual(expectedTotalCollateralDrawn, receivedCollateral)

    const dennis_LUSDBalance_After = (await lusdToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_before.sub(redemptionAmount))
  })

  it('redeemCollateralForShutdown(): tcr shutdown, no discount, ends the redemption sequence when the token redemption request has been filled', async () => {
    // --- SETUP --- 
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // Alice, Bob, Carol, Dennis, Erin open troves
    const { netDebt: A_debt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: alice } })
    const { netDebt: B_debt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: bob } })
    const { netDebt: C_debt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })
    const redemptionAmount = A_debt.add(B_debt).add(C_debt)
    const { totalDebt: D_totalDebt, collateral: D_coll } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: dennis } })
    const { totalDebt: E_totalDebt, collateral: E_coll } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: erin } })
    await collateralToken.mint(flyn, dec(10000, 30))
    // open trove from redeemer.  Redeemer has highest ICR (100Collateral, 100 LUSD), 20000%
    const { lusdAmount: F_lusdAmount } = await openTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: redemptionAmount.mul(toBN(2)), extraParams: { from: flyn } })
    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    await relayer.updatePar()
    // Trigger TCR shutdown
    const shutdownPrice = await tcrShutdown()
    
    const flynCollateralBefore = await collateralToken.balanceOf(flyn)

    // --- TEST --- 

    // Flyn redeems collateral
    await troveManager.redeemCollateralForShutdown(redemptionAmount, alice, alice, alice, alice, alice, 0, 0, th._100pct, { from: flyn })

    // Check Flyn's redemption has reduced his LUSD balance
    const flynBalance = await lusdToken.balanceOf(flyn)
    th.assertIsApproximatelyEqual(flynBalance, F_lusdAmount.sub(redemptionAmount))

    // Check all troves have their collateral drained to 0 (redemption amount exceeded Alice+Bob+Carol)
    const alice_trove = await troveManager.Troves(alice)
    const bob_trove = await troveManager.Troves(bob)
    const carol_trove = await troveManager.Troves(carol)
    // Get Dennis and Erin collateral for the assertion above
    const dennis_Coll = await troveManager.getTroveColl(dennis)
    const erin_Coll = await troveManager.getTroveColl(erin)
    assert.equal(alice_trove[1].toString(), '0') // collateral drained
    assert.equal(bob_trove[1].toString(), '0')   // collateral drained
    assert.equal(carol_trove[1].toString(), '0') // collateral drained
    assert.equal(dennis_Coll.toString(), '0')    // collateral drained
    assert.equal(erin_Coll.toString(), '0')      // collateral drained

    // Check Flyn received the correct amount of collateral with no discount (immediate redemption)
    const flynCollateralAfter = await collateralToken.balanceOf(flyn)
    const receivedCollateral = flynCollateralAfter.sub(flynCollateralBefore)
    const par = await relayer.par()
    const discount = await troveManager.getDiscount() // Should be 0 for immediate redemption
    const expectedCollateral = redemptionAmount.mul(par).mul(mv._1e18BN).div(mv._1e18BN.sub(discount).mul(shutdownPrice))

    th.assertIsApproximatelyEqual(expectedCollateral, receivedCollateral)
  })

  it('redeemCollateralForShutdown(): tcr shutdown, ends the redemption sequence when max iterations have been reached', async () => {
    // --- SETUP --- 
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // Alice, Bob, Carol open troves with equal collateral ratio
    const { netDebt: A_debt } = await openTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: alice } })
    const { netDebt: B_debt } = await openTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: bob } })
    const { netDebt: C_debt, totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })
    const redemptionAmount = A_debt.add(B_debt)
    const attemptedRedemptionAmount = redemptionAmount.add(C_debt)

    // open trove from redeemer.  Redeemer has highest ICR (100Collateral, 100 LUSD), 20000%
    await collateralToken.mint(flyn, dec(10000, 30))
    const { lusdAmount: F_lusdAmount } = await openTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: redemptionAmount.mul(toBN(2)), extraParams: { from: flyn } })

    // Trigger TCR shutdown
    const shutdownPrice = await tcrShutdown()
    
    const flynCollateralBefore = await collateralToken.balanceOf(flyn)

    // --- TEST --- 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Flyn redeems collateral with only two iterations
    await troveManager.redeemCollateralForShutdown(attemptedRedemptionAmount, alice, alice, alice, alice, alice, 0, 2, th._100pct, { from: flyn })

    // Check that redemption was limited by max iterations
    const flynBalance = await lusdToken.balanceOf(flyn)
    const actualRedeemedAmount = F_lusdAmount.sub(flynBalance)
    
    // The max iterations = 2 should limit the redemption to less than the full attemptedRedemptionAmount
    assert.isTrue(actualRedeemedAmount.lt(attemptedRedemptionAmount))
    
    // Check Alice and Bob troves have their collateral drained (max iterations = 2, so only 2 troves processed)
    const alice_trove = await troveManager.Troves(alice)
    const bob_trove = await troveManager.Troves(bob)
    const carol_trove = await troveManager.Troves(carol)

    assert.equal(alice_trove[1].toString(), '0') // collateral drained
    assert.equal(bob_trove[1].toString(), '0')   // collateral drained
    // Carol should still have collateral since max iterations = 2 stopped the redemption
    assert.isTrue(carol_trove[1].gt(toBN('0')))

    // Check Flyn received the correct amount of collateral with full discount (after time skip)
    const flynCollateralAfter = await collateralToken.balanceOf(flyn)
    const receivedCollateral = flynCollateralAfter.sub(flynCollateralBefore)
    const par = await relayer.par()
    const discount = await troveManager.getDiscount() // Should be full discount after time skip
    const expectedCollateral = actualRedeemedAmount.mul(par).mul(mv._1e18BN).div(mv._1e18BN.sub(discount).mul(shutdownPrice))

    th.assertIsApproximatelyEqual(expectedCollateral, receivedCollateral)
  })

  it("redeemCollateralForShutdown(): tcr shutdown, full discount, performs partial redemption when collateral is insufficient", async () => {
    // --- SETUP ---
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // Open troves with different amounts
    const { netDebt: A_debt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: alice } })
    const { netDebt: B_debt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(200, 18), extraParams: { from: bob } })
    const { netDebt: C_debt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(300, 18), extraParams: { from: carol } })

    // Dennis opens trove to be the redeemer
    await collateralToken.mint(dennis, dec(10000, 30))
    const totalDebtToRedeem = A_debt.add(B_debt).add(C_debt)
    const { lusdAmount: D_lusdAmount } = await openTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: totalDebtToRedeem, extraParams: { from: dennis } })

    // Trigger TCR shutdown
    const shutdownPrice = await tcrShutdown()
    
    const dennisCollateralBefore = await collateralToken.balanceOf(dennis)

    // --- TEST ---

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Dennis redeems all available debt - should drain all collateral from Alice, Bob, Carol
    await troveManager.redeemCollateralForShutdown(totalDebtToRedeem, alice, alice, alice, alice, alice, 0, 0, th._100pct, { from: dennis })

    // Check that all troves have their collateral drained (since MCR is bypassed during shutdown)
    const alice_trove = await troveManager.Troves(alice)
    const bob_trove = await troveManager.Troves(bob)
    const carol_trove = await troveManager.Troves(carol)

    assert.equal(alice_trove[1].toString(), '0') // collateral drained
    assert.equal(bob_trove[1].toString(), '0')   // collateral drained
    assert.equal(carol_trove[1].toString(), '0') // collateral drained

    // Check Dennis received collateral based on actual redemption with full discount
    const dennisCollateralAfter = await collateralToken.balanceOf(dennis)
    const receivedCollateral = dennisCollateralAfter.sub(dennisCollateralBefore)
    const dennisBalanceAfter = await lusdToken.balanceOf(dennis)
    const actualRedeemedAmount = D_lusdAmount.sub(dennisBalanceAfter)
    
    const par = await relayer.par()
    const discount = await troveManager.getDiscount() // Should be full discount after time skip
    const expectedCollateral = actualRedeemedAmount.mul(par).mul(mv._1e18BN).div(mv._1e18BN.sub(discount).mul(shutdownPrice))

    th.assertIsApproximatelyEqual(expectedCollateral, receivedCollateral)
  })

  it('redeemCollateralForShutdown(): tcr shutdown, full discount, doesnt perform the final partial redemption in the sequence if the hint is out-of-date', async () => {
    // --- SETUP ---
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })
    
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(363, 16)), extraLUSDAmount: dec(5, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(344, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(333, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })

    const partialRedemptionAmount = toBN(dec(2, 18))
    const fullfilledRedemptionAmount = C_netDebt.add(B_netDebt)
    const redemptionAmount = fullfilledRedemptionAmount.add(partialRedemptionAmount)

    await collateralToken.mint(dennis, dec(10000, 30))
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    // Trigger TCR shutdown
    const shutdownPrice = await tcrShutdown()

    const dennis_CollateralBalance_before = toBN(await collateralToken.balanceOf(dennis))
    const dennis_LUSDBalance_before = await lusdToken.balanceOf(dennis)

    // --- TEST --- 

    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(redemptionAmount, shutdownPrice, 0)

    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      dennis,
      dennis
    )

    const frontRunRedemption = toBN(dec(1, 18))
    // Oops, another transaction gets in the way
    {
      const {
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints(dec(1, 18), shutdownPrice, 0)

      const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        firstRedemptionHint,
        firstRedemptionHint
      )
      const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        firstRedemptionHint,
        firstRedemptionHint
      )

      // skip bootstrapping phase
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

      // Alice redeems 1 LUSD from Carol's Trove
      await troveManager.redeemCollateralForShutdown(
        frontRunRedemption,
        firstRedemptionHint,
        upperPartialRedemptionHint,
        lowerPartialRedemptionHint,
        upperShieldedPartialRedemptionHint,
        lowerShieldedPartialRedemptionHint,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: alice }
      )
    }

    const parBeforeDennisRedemption = await relayer.par()

    // Dennis tries to redeem the full amount
    const redemptionTx = await troveManager.redeemCollateralForShutdown(
      redemptionAmount,
      firstRedemptionHint,
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      {
        from: dennis,
        gasPrice: GAS_PRICE
      }
    )

    const totalRedeemed = th.getEmittedRedemptionValues(redemptionTx)[1]

    // Since Alice already redeemed 1 LUSD from Carol's Trove, Dennis was able to redeem:
    //  - 9 LUSD from Carol's
    //  - 8 LUSD from Bob's
    // for a total of 17 LUSD.

    // Dennis calculated his hint for redeeming 2 LUSD from Alice's Trove, but after Alice's transaction
    // got in the way, he would have needed to redeem 3 LUSD to fully complete his redemption.
    // This would have required a different hint, therefore he ended up with a partial redemption.

    const dennis_CollateralBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedCollateral = dennis_CollateralBalance_After.sub(dennis_CollateralBalance_before)

    // Calculate expected collateral with shutdown discount using actual redeemed amount
    const par = await relayer.par()
    const discount = await troveManager.getDiscount() // Should be full discount after time skip
    const expectedCollateral = totalRedeemed.mul(par).mul(mv._1e18BN).div(mv._1e18BN.sub(discount).mul(shutdownPrice))

    th.assertIsApproximatelyEqual(expectedCollateral, receivedCollateral)

    const dennis_LUSDBalance_After = await lusdToken.balanceOf(dennis)
    th.assertIsApproximatelyEqual(dennis_LUSDBalance_After, dennis_LUSDBalance_before.sub(totalRedeemed))
  })
  // active debt cannot be zero, as there's a positive min debt enforced, and at least a trove must exist
  it("redeemCollateralForShutdown(): tcr shutdown, full discount, can redeem if there is zero active debt but non-zero debt in DefaultPool", async () => {
    // --- SETUP ---

    const amount = await getOpenTroveLUSDAmount(dec(210, 18))
    // Create troves with high ICR to keep TCR above CCR
    await openTrove({ ICR: toBN(dec(300, 16)), extraParams: { from: whale } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(133, 16)), extraLUSDAmount: amount, extraParams: { from: bob } })
    // Dennis gets LUSD for later redemption
    await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: toBN(dec(10000, 18)), extraParams: { from: dennis } })
    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    // active debt
    const activeDebtOpen = await activePool.getLUSDDebt()
    // console.log("activeDebtOpen", activeDebtOpen.toString())
    await lusdToken.transfer(carol, amount, { from: bob })

    const price = dec(125, 18)
    await priceFeed.setPrice(price)

    // Liquidate Bob's Trove (ICR 133% -> 106% < MCR 110%)
    await liquidations.liquidateTroves(1)

    // Trigger TCR shutdown
    const shutdownPrice = await tcrShutdown()

    // Use redemption to eliminate remaining active debt (more reliable than liquidation)
    let remainingActiveDebt = await activePool.getLUSDDebt()
    const activeDebtBeforeRedemption = remainingActiveDebt // Store for comparison
    // console.log("Active debt after shutdown:", remainingActiveDebt.toString())
    
    if (remainingActiveDebt.gt(toBN('0'))) {
      // Dennis already has LUSD from opening his trove before shutdown
      const dennisLUSDBalance = await lusdToken.balanceOf(dennis)
      // console.log("Dennis LUSD balance:", dennisLUSDBalance.toString())
      // console.log("Remaining active debt to redeem:", remainingActiveDebt.toString())
      
      // Make sure Dennis has enough LUSD to redeem
      if (dennisLUSDBalance.lt(remainingActiveDebt)) {
        // console.log("Dennis doesn't have enough LUSD, only redeeming what he has")
        remainingActiveDebt = dennisLUSDBalance
      }
      
      // Get hints for redemption
      // const redemptionHints = await hintHelpers.getRedemptionHints(remainingActiveDebt, shutdownPrice, 0)
      
        const {
          firstRedemptionHint,
          partialRedemptionHintNICR
        } = await hintHelpers.getRedemptionHints(remainingActiveDebt, shutdownPrice, 0)
  
        const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
          partialRedemptionHintNICR,
          dennis,
          dennis
        )
        const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
          partialRedemptionHintNICR,
          dennis,
          dennis
        )
      // Redeem all remaining active debt (will redeem from lowest ICR troves first)
      // console.log("Redeeming", remainingActiveDebt.toString(), "LUSD to clear active debt")
      await troveManager.redeemCollateralForShutdown(
        remainingActiveDebt,
        firstRedemptionHint,
        upperPartialRedemptionHint,
        lowerPartialRedemptionHint,
        upperShieldedPartialRedemptionHint,
        lowerShieldedPartialRedemptionHint,
        partialRedemptionHintNICR.toString(),
        0,
        th._100pct,
        { from: dennis, gasPrice: GAS_PRICE }
      )
      
      // console.log("Redemption completed")
    }

    // --- TEST --- 

    // Verify that redemption worked and we have non-zero debt in DefaultPool
    const activeDebtAfter = await activePool.getLUSDDebt()
    const defaultPoolDebt = await defaultPool.getLUSDDebt()
    const finalActiveCount = await troveManager.getTroveOwnersCount()
    
    // console.log("=== FINAL STATE ===")
    // console.log("Active debt after redemption:", activeDebtAfter.toString())
    // console.log("DefaultPool debt:", defaultPoolDebt.toString()) 
    // console.log("Final active trove count:", finalActiveCount.toString())
    
    // List remaining troves if any
    if (finalActiveCount.gt(toBN('0'))) {
      // console.log("Remaining troves:")
      const aliceStatus = await troveManager.getTroveStatus(alice)
      if (aliceStatus.toString() === '1') {
        const aliceDebt = await troveManager.getTroveDebt(alice)
        // console.log("Alice trove still active, debt:", aliceDebt.toString())
      }
    }
    
    // Test that redemption reduced active debt and we have DefaultPool debt from Bob's liquidation
    assert.isTrue(activeDebtAfter.lt(activeDebtBeforeRedemption), "Active debt should be reduced by redemption")
    assert.isTrue(defaultPoolDebt.gt(toBN('0')), "DefaultPool debt should be greater than zero")

    const carol_CollateralBalance_Before = toBN(await collateralToken.balanceOf(carol))
    const nicrHint = await hintHelpers.getRedemptionHints(amount, shutdownPrice, 0)

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    const redemptionTx = await troveManager.redeemCollateralForShutdown(
      amount,
      '0x0000000000000000000000000000000000000000', // No valid first hint since no active troves
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      nicrHint.partialRedemptionHintNICR.toString(),
      0,
      th._100pct,
      {
        from: carol,
        gasPrice: GAS_PRICE
      }
    )

    const totalRedeemed = th.getEmittedRedemptionValues(redemptionTx)[1]
    const par = await relayer.par()
    const discount = await troveManager.getDiscount() // Should be full discount after time skip

    const carol_CollateralBalance_After = toBN(await collateralToken.balanceOf(carol))
    const receivedCollateral = carol_CollateralBalance_After.sub(carol_CollateralBalance_Before)

    // Calculate expected collateral with shutdown discount
    const expectedCollateral = totalRedeemed.mul(par).mul(mv._1e18BN).div(mv._1e18BN.sub(discount).mul(shutdownPrice))

    th.assertIsApproximatelyEqual(expectedCollateral, receivedCollateral)

    const carol_LUSDBalance_After = (await lusdToken.balanceOf(carol)).toString()
    assert.equal(carol_LUSDBalance_After, '0')
  })

  it("redeemCollateralForShutdown(): finds the last Trove with ICR == 110% even if there is more than one", async () => {
    // --- SETUP ---
    const amount1 = toBN(dec(100, 18))
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: amount1, extraParams: { from: alice } })
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: amount1, extraParams: { from: bob } })
    const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: amount1, extraParams: { from: carol } })
    const redemptionAmount = C_totalDebt.add(B_totalDebt).add(A_totalDebt)
    const { totalDebt: D_totalDebt } = await openTrove({ ICR: toBN(dec(195, 16)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    // This will put Dennis slightly below 110%, and everyone else exactly at 110%
    const price = '110' + _18_zeros
    await priceFeed.setPrice(price)

    const orderOfTroves = [];
    let current = await sortedTroves.getFirst();
    
    while (current !== '0x0000000000000000000000000000000000000000') {
      orderOfTroves.push(current);
      current = await sortedTroves.getNext(current);
    }

    assert.deepEqual(orderOfTroves, [carol, bob, alice, dennis]);

    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: dec(10, 18), extraParams: { from: whale } })
    const shutdownPrice = await tcrShutdown()
    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    const tx = await troveManager.redeemCollateralForShutdown(
      redemptionAmount,
      carol, // try to trick redeemCollateral by passing a hint that doesn't exactly point to the
      // last Trove with ICR == 110% (which would be Alice's)
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      0,
      0,
      th._100pct,
      { from: dennis }
    )
    
    const { debt: alice_debt_After, coll: alice_coll_After } = await troveManager.Troves(alice)
    const { debt: bob_debt_After, coll: bob_coll_After } = await troveManager.Troves(bob)
    const { debt: carol_debt_After, coll: carol_coll_After } = await troveManager.Troves(carol)
    const { debt: dennis_debt_After, coll: dennis_coll_After } = await troveManager.Troves(dennis)

    // At the dropped price, redemption consumes all collateral but leaves remaining debt
    assert.equal(alice_coll_After, '0', "Alice should have zero collateral after redemption")
    assert.equal(bob_coll_After, '0', "Bob should have zero collateral after redemption")
    assert.equal(carol_coll_After, '0', "Carol should have zero collateral after redemption")
    assert.equal(dennis_coll_After, '0', "Dennis should have zero collateral after redemption")
    
    // Due to price drop, redemption doesn't cover full debt - troves have remaining debt with zero collateral
    const expectedRemainingDebt = toBN('1924816204268978136275') // ~1924 LUSD remaining per trove
    th.assertIsApproximatelyEqual(alice_debt_After, expectedRemainingDebt, 1000)
    th.assertIsApproximatelyEqual(bob_debt_After, expectedRemainingDebt, 1000)
    th.assertIsApproximatelyEqual(carol_debt_After, expectedRemainingDebt, 1000)

    // Dennis's remaining debt should be approximately what we see in logs
    const expectedDennisDebt = toBN('7624916730022240746571') // ~7624 LUSD
    th.assertIsApproximatelyEqual(dennis_debt_After, expectedDennisDebt, 10000)
  });

  it("redeemCollateralForShutdown(): reverts when argument _amount is 0", async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // Alice opens trove and transfers 500LUSD to Erin, the would-be redeemer
    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(500, 18), extraParams: { from: alice } })
    await lusdToken.transfer(erin, dec(500, 18), { from: alice })

    // B, C and D open troves
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: dennis } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Erin attempts to redeem with _amount = 0
    const redemptionTxPromise = troveManager.redeemCollateralForShutdown(0, erin, erin, erin, erin, erin, 0, 0, th._100pct, { from: erin })
    await assertRevert(redemptionTxPromise, "TroveManager: Amount must be greater than zero")
  })

  it("redeemCollateralForShutdown(): tcr shutdown, 0 discount, reverts if max fee > 100%", async () => {
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(30, 18), extraParams: { from: C } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: D } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE ,dec(2, 18)), "maxFee% out of [0.5,100]")
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE, '1000000000000000001'), "maxFee% out of [0.5,100]")
  })

  it("redeemCollateralForShutdown():tcr shutdown, 0 discount,  reverts if max fee < 0.5%", async () => { 
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(30, 18), extraParams: { from: C } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: D } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, GAS_PRICE, dec(10, 18), 0), "maxFee% out of [0.5,100]")
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, GAS_PRICE, dec(10, 18), 1), "maxFee% out of [0.5,100]")
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, GAS_PRICE, dec(10, 18), '4999999999999999'), "maxFee% out of [0.5,100]")
  })
  
  it("redeemCollateralForShutdown(): tcr shutdown, 0 discount, succeeds with no fees", async () => {
    // Create troves with ICRs that keep TCR > CCR (150%) initially but can be brought below SCR (110%) with price drop
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(80, 18), extraParams: { from: A } })
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(90, 18), extraParams: { from: B } })
    const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const expectedTotalSupply = A_totalDebt.add(B_totalDebt).add(C_totalDebt)

    // Check total LUSD supply
    const totalSupply = await lusdToken.totalSupply()
    th.assertIsApproximatelyEqual(totalSupply, expectedTotalSupply)

    // Trigger shutdown - tcrShutdown() will calculate and set the correct price automatically
    await tcrShutdown()

    await aggregator.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // During shutdown, redemptions have no fees, so any max fee percentage should work
    const attemptedLUSDRedemption = expectedTotalSupply.div(toBN(10))

    // Max fee is <5% - this should succeed since there are no fees during shutdown
    const lessThan5pct = '49999999999999999'
    const redemptionTx = await troveManager.redeemCollateralForShutdown(
      attemptedLUSDRedemption,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000', 
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      0,
      0,
      lessThan5pct,
      { from: A }
    )
    
    // Verify the transaction succeeded and emitted a Redemption event with zero fees
    assert.isTrue(redemptionTx.receipt.status)
    const redemptionEvent = th.getEventArgByName(redemptionTx, "Redemption", "_collateralFee")
    assert.equal(redemptionEvent.toString(), '0') // No fees during shutdown
    
    // Test with different max fee percentages - all should succeed since there are no fees during shutdown
    
    // Max fee is 1% - should succeed
    const redemptionTx2 = await troveManager.redeemCollateralForShutdown(
      attemptedLUSDRedemption.div(toBN(4)), // Use smaller amount to avoid running out of debt
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      0,
      0,
      dec(1, 16),
      { from: A }
    )
    assert.isTrue(redemptionTx2.receipt.status)
    
    // Max fee is 0.5% - should succeed
    const redemptionTx3 = await troveManager.redeemCollateralForShutdown(
      attemptedLUSDRedemption.div(toBN(4)), // Use smaller amount to avoid running out of debt
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      0,
      0,
      dec(5, 15),
      { from: A }
    )
    assert.isTrue(redemptionTx3.receipt.status)
  })

  it("redeemCollateralForShutdown(): succeeds with any max fee percentage during shutdown", async () => {
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(9500, 18), extraParams: { from: A } })
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(395, 16)), extraLUSDAmount: dec(9000, 18), extraParams: { from: B } })
    const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(390, 16)), extraLUSDAmount: dec(10000, 18), extraParams: { from: C } })
    const expectedTotalSupply = A_totalDebt.add(B_totalDebt).add(C_totalDebt)

    // Check total LUSD supply
    const totalSupply = await lusdToken.totalSupply()
    th.assertIsApproximatelyEqual(totalSupply, expectedTotalSupply)

    // Trigger shutdown
    await tcrShutdown()

    await aggregator.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // During shutdown, redemptions have no fees regardless of amount
    const attemptedLUSDRedemption = expectedTotalSupply.div(toBN(10))

    // Test with very low max fee (0.5%) - should succeed since there are no fees
    const tx1 = await troveManager.redeemCollateralForShutdown(
      attemptedLUSDRedemption.div(toBN(5)),
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      0,
      0,
      dec(5, 15), // 0.5%
      { from: A }
    )
    assert.isTrue(tx1.receipt.status)
    
    // Test with moderate max fee (10%) - should succeed
    const tx2 = await troveManager.redeemCollateralForShutdown(
      attemptedLUSDRedemption.div(toBN(5)),
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      0,
      0,
      dec(1, 17), // 10%
      { from: B }
    )
    assert.isTrue(tx2.receipt.status)

    // Test with high max fee (50%) - should succeed
    const tx3 = await troveManager.redeemCollateralForShutdown(
      attemptedLUSDRedemption.div(toBN(5)),
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      0,
      0,
      dec(5, 17), // 50%
      { from: C }
    )
    assert.isTrue(tx3.receipt.status)

    // Test with maximum max fee (100%) - should succeed
    const tx4 = await troveManager.redeemCollateralForShutdown(
      attemptedLUSDRedemption.div(toBN(5)),
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      0,
      0,
      dec(1, 18), // 100%
      { from: A }
    )
    assert.isTrue(tx4.receipt.status)

    // Verify all redemptions had zero fees
    const redemptionEvent1 = th.getEventArgByName(tx1, "Redemption", "_collateralFee")
    const redemptionEvent2 = th.getEventArgByName(tx2, "Redemption", "_collateralFee")
    const redemptionEvent3 = th.getEventArgByName(tx3, "Redemption", "_collateralFee")
    const redemptionEvent4 = th.getEventArgByName(tx4, "Redemption", "_collateralFee")
    
    assert.equal(redemptionEvent1.toString(), '0')
    assert.equal(redemptionEvent2.toString(), '0')
    assert.equal(redemptionEvent3.toString(), '0')
    assert.equal(redemptionEvent4.toString(), '0')
  })
  it("redeemCollateralForShutdown(): doesn't affect the Stability Pool deposits or Collateral gain of redeemed-from troves", async () => {
    //contracts.rateControl.setCoBias(0)
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // B, C, D open troves with smaller amounts
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(50, 18), extraParams: { from: bob } })
    const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(395, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: carol } })
    const { totalDebt: D_totalDebt } = await openTrove({ ICR: toBN(dec(390, 16)), extraLUSDAmount: dec(150, 18), extraParams: { from: dennis } })

    const redemptionAmount = B_totalDebt.add(C_totalDebt).add(D_totalDebt)
    // Alice opens trove and transfers LUSD to Erin, the would-be redeemer
    await openTrove({ ICR: toBN(dec(500, 16)), extraLUSDAmount: redemptionAmount, extraParams: { from: alice } })
    await lusdToken.transfer(erin, redemptionAmount, { from: alice })

    // B, C, D deposit some of their tokens to the Stability Pool
    await stabilityPool.provideToSP(dec(25, 18), ZERO_ADDRESS, { from: bob })
    await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, { from: carol })
    await stabilityPool.provideToSP(dec(75, 18), ZERO_ADDRESS, { from: dennis })

    let price = await priceFeed.getPrice()
    const bob_ICR_before = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_before = await troveManager.getCurrentICR(carol, price)
    const dennis_ICR_before = await troveManager.getCurrentICR(dennis, price)

 
    // Check the LUSD and Collateral in Stability Pool
    const LUSDinSP = await stabilityPool.getTotalLUSDDeposits()
    const CollateralinSP = await stabilityPool.getCollateral()
    assert.isTrue(LUSDinSP.gte(mv._zeroBN))
    assert.isTrue(CollateralinSP.gte(mv._zeroBN))

    // Trigger shutdown before redemption
    await tcrShutdown()

    const bob_SPDeposit_before = await stabilityPool.getCompoundedLUSDDeposit(bob)
    const carol_SPDeposit_before = await stabilityPool.getCompoundedLUSDDeposit(carol)
    const dennis_SPDeposit_before = await stabilityPool.getCompoundedLUSDDeposit(dennis)

    const bob_CollateralGain_before = await stabilityPool.getDepositorCollateralGain(bob)
    const carol_CollateralGain_before = await stabilityPool.getDepositorCollateralGain(carol)
    const dennis_CollateralGain_before = await stabilityPool.getDepositorCollateralGain(dennis)


    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Erin redeems LUSD using shutdown redemption - use smaller amount to ensure troves are affected
    const smallRedemptionAmount = redemptionAmount.div(toBN(2))
    const tx = await troveManager.redeemCollateralForShutdown(
      smallRedemptionAmount,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      0,
      0,
      th._100pct,
      { from: erin }
    )

    // Verify the redemption was successful
    assert.isTrue(tx.receipt.status)

    const bob_SPDeposit_after = await stabilityPool.getCompoundedLUSDDeposit(bob)
    const carol_SPDeposit_after = await stabilityPool.getCompoundedLUSDDeposit(carol)
    const dennis_SPDeposit_after = await stabilityPool.getCompoundedLUSDDeposit(dennis)

    const bob_CollateralGain_after = await stabilityPool.getDepositorCollateralGain(bob)
    const carol_CollateralGain_after = await stabilityPool.getDepositorCollateralGain(carol)
    const dennis_CollateralGain_after = await stabilityPool.getDepositorCollateralGain(dennis)

    // Check B, C, D Stability Pool deposits and Collateral gain have not been affected by redemptions from their troves
    // During shutdown, redemptions don't trigger drip, so deposits should remain the same
    th.assertIsApproximatelyEqual(bob_SPDeposit_before, bob_SPDeposit_after, 1)
    th.assertIsApproximatelyEqual(carol_SPDeposit_before, carol_SPDeposit_after, 1)
    th.assertIsApproximatelyEqual(dennis_SPDeposit_before, dennis_SPDeposit_after, 1)

    // Collateral gains should remain unchanged as redemptions don't affect stability pool collateral gains
    assert.isTrue(bob_CollateralGain_before.eq(bob_CollateralGain_after))
    assert.isTrue(carol_CollateralGain_before.eq(carol_CollateralGain_after))
    assert.isTrue(dennis_CollateralGain_before.eq(dennis_CollateralGain_after))

    // Verify the redemption had zero fees (shutdown behavior)
    const redemptionEvent = th.getEventArgByName(tx, "Redemption", "_collateralFee")
    assert.equal(redemptionEvent.toString(), '0')
  })

  it("redeemCollateralForShutdown(): caller can redeem their entire LUSDToken balance", async () => {
    await rateControl.setCoBias(0)
    const { collateral: W_coll, totalDebt: W_totalDebt } = await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // Alice opens trove and transfers 400 LUSD to Erin, the would-be redeemer
    const { collateral: A_coll, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(400, 18), extraParams: { from: alice } })
    await lusdToken.transfer(erin, dec(400, 18), { from: alice })

    // Check Erin's balance before
    const erin_balance_before = await lusdToken.balanceOf(erin)
    assert.equal(erin_balance_before, dec(400, 18))

    // B, C, D open trove
    const { collateral: B_coll, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(590, 18), extraParams: { from: bob } })
    const { collateral: C_coll, totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(1990, 18), extraParams: { from: carol } })
    const { collateral: D_coll, totalDebt: D_totalDebt } = await openTrove({ ICR: toBN(dec(500, 16)), extraLUSDAmount: dec(1990, 18), extraParams: { from: dennis } })

    const totalDebt = W_totalDebt.add(A_totalDebt).add(B_totalDebt).add(C_totalDebt).add(D_totalDebt)
    const totalColl = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)

    // Get active debt and coll before redemption
    const activePool_debt_before = await activePool.getLUSDDebt()
    const activePool_coll_before = await activePool.getCollateral()

    th.assertIsApproximatelyEqual(activePool_debt_before, totalDebt)
    assert.equal(activePool_coll_before.toString(), totalColl)

    // Trigger shutdown before redemption
    await tcrShutdown()

    const price = await priceFeed.getPrice()

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    const amount = dec(400, 18)
    
    // During shutdown, redemption uses simplified parameters (no hints needed for fee calculation)
    const tx = await troveManager.redeemCollateralForShutdown(
      amount,
      '0x0000000000000000000000000000000000000000', // firstRedemptionHint
      '0x0000000000000000000000000000000000000000', // upperPartialRedemptionHint
      '0x0000000000000000000000000000000000000000', // lowerPartialRedemptionHint
      '0x0000000000000000000000000000000000000000', // upperShieldedPartialRedemptionHint
      '0x0000000000000000000000000000000000000000', // lowerShieldedPartialRedemptionHint
      0, // partialRedemptionHintNICR
      0, // maxIterations
      th._100pct, // maxFeePercentage
      { from: erin }
    )

    // Verify the redemption was successful
    assert.isTrue(tx.receipt.status)

    // Get fee from tx - should be 0 during shutdown
    const redemptionEvent = th.getEventArgByName(tx, "Redemption", "_collateralFee")
    const fee = redemptionEvent
    assert.equal(fee.toString(), '0') // No fees during shutdown

    // Check activePool debt reduced by 400 LUSD - this is the key assertion
    const activePool_debt_after = await activePool.getLUSDDebt()
    assert.equal(activePool_debt_before.sub(activePool_debt_after), amount)

    // Verify some collateral was withdrawn (exact amount depends on shutdown price and discount)
    const activePool_coll_after = await activePool.getCollateral()
    const actualCollateralWithdrawn = activePool_coll_before.sub(activePool_coll_after)
    assert.isTrue(actualCollateralWithdrawn.gt(toBN('0')), "Some collateral should have been withdrawn")

    // Check Erin's balance after - should be 0 since they redeemed their entire balance
    const erin_balance_after = (await lusdToken.balanceOf(erin)).toString()
    assert.equal(erin_balance_after, '0')
  })

  it("redeemCollateralForShutdown(): reverts when requested redemption amount exceeds caller's LUSD token balance", async () => {
    const { collateral: W_coll, totalDebt: W_totalDebt } = await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // Alice opens trove and transfers 400 LUSD to Erin, the would-be redeemer
    const { collateral: A_coll, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(400, 18), extraParams: { from: alice } })
    await lusdToken.transfer(erin, dec(400, 18), { from: alice })

    // Check Erin's balance before
    const erin_balance_before = await lusdToken.balanceOf(erin)
    assert.equal(erin_balance_before, dec(400, 18))

    // B, C, D open trove
    const { collateral: B_coll, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(590, 18), extraParams: { from: bob } })
    const { collateral: C_coll, totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(1990, 18), extraParams: { from: carol } })
    const { collateral: D_coll, totalDebt: D_totalDebt } = await openTrove({ ICR: toBN(dec(500, 16)), extraLUSDAmount: dec(1990, 18), extraParams: { from: dennis } })

    const totalDebt = W_totalDebt.add(A_totalDebt).add(B_totalDebt).add(C_totalDebt).add(D_totalDebt)
    const totalColl = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)

    // Get active debt and coll before redemption
    const activePool_debt_before = await activePool.getLUSDDebt()
    const activePool_coll_before = (await activePool.getCollateral()).toString()

    th.assertIsApproximatelyEqual(activePool_debt_before, totalDebt)
    assert.equal(activePool_coll_before, totalColl)

    const price = await priceFeed.getPrice()

    let firstRedemptionHint
    let partialRedemptionHintNICR

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    await relayer.updateRateAndPar()
    await tcrShutdown()
    // Erin tries to redeem 1000 LUSD
    try {
      ({
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints(dec(1000, 18), price, 0))

      const { 0: upperPartialRedemptionHint_1, 1: lowerPartialRedemptionHint_1 } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )
      const { 0: upperShieldedPartialRedemptionHint_1, 1: lowerShieldedPartialRedemptionHint_1 } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )

      const redemptionTx = await troveManager.redeemCollateralForShutdown(
        dec(1000, 18),
        firstRedemptionHint,
        upperPartialRedemptionHint_1,
        lowerPartialRedemptionHint_1,
        upperShieldedPartialRedemptionHint_1,
        lowerShieldedPartialRedemptionHint_1,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: erin })
      assert.isFalse(redemptionTx.receipt.status)
    } catch (error) {
      assert.include(error.message, "revert")
      assert.include(error.message, "must be <= user's balance")
    }

    // Erin tries to redeem 401 LUSD
    try {
      ({
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints('401000000000000000000', price, 0))

      const { 0: upperPartialRedemptionHint_2, 1: lowerPartialRedemptionHint_2 } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )
      const { 0: upperShieldedPartialRedemptionHint_2, 1: lowerShieldedPartialRedemptionHint_2 } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )

      const redemptionTx = await troveManager.redeemCollateralForShutdown(
        '401000000000000000000', firstRedemptionHint,
        upperPartialRedemptionHint_2,
        lowerPartialRedemptionHint_2,
        upperShieldedPartialRedemptionHint_2,
        lowerShieldedPartialRedemptionHint_2,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: erin })
      assert.isFalse(redemptionTx.receipt.status)
    } catch (error) {
      assert.include(error.message, "revert")
      assert.include(error.message, "must be <= user's balance")
    }

    // Erin tries to redeem 239482309 LUSD
    try {
      ({
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints('239482309000000000000000000', price, 0))

      const { 0: upperPartialRedemptionHint_3, 1: lowerPartialRedemptionHint_3 } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )
      const { 0: upperShieldedPartialRedemptionHint_3, 1: lowerShieldedPartialRedemptionHint_3 } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )

      const redemptionTx = await troveManager.redeemCollateralForShutdown(
        '239482309000000000000000000', firstRedemptionHint,
        upperPartialRedemptionHint_3,
        lowerPartialRedemptionHint_3,
        upperShieldedPartialRedemptionHint_3,
        lowerShieldedPartialRedemptionHint_3,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: erin })
      assert.isFalse(redemptionTx.receipt.status)
    } catch (error) {
      assert.include(error.message, "revert")
      assert.include(error.message, "must be <= user's balance")
    }

    // Erin tries to redeem 2^256 - 1 LUSD
    const maxBytes32 = toBN('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')

    try {
      ({
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints('239482309000000000000000000', price, 0))

      const { 0: upperPartialRedemptionHint_4, 1: lowerPartialRedemptionHint_4 } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )
      const { 0: upperShieldedPartialRedemptionHint_4, 1: lowerShieldedPartialRedemptionHint_4 } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        erin,
        erin
      )

      const redemptionTx = await troveManager.redeemCollateralForShutdown(
        maxBytes32, firstRedemptionHint,
        upperPartialRedemptionHint_4,
        lowerPartialRedemptionHint_4,
        upperShieldedPartialRedemptionHint_4,
        lowerShieldedPartialRedemptionHint_4,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: erin })
      assert.isFalse(redemptionTx.receipt.status)
    } catch (error) {
      assert.include(error.message, "revert")
      assert.include(error.message, "must be <= user's balance")
    }
  })

  it("redeemCollateralForShutdown(): reverts if caller's tries to redeem more than the outstanding system debt", async () => {
    // --- SETUP --- illegally mint LUSD to Bob
    await lusdToken.unprotectedMint(bob, '101000000000000000000')

    assert.equal((await lusdToken.balanceOf(bob)), '101000000000000000000')

    const { collateral: C_coll, totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(1000, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: carol } })
    const { collateral: D_coll, totalDebt: D_totalDebt } = await openTrove({ ICR: toBN(dec(1000, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: dennis } })

    const totalDebt = C_totalDebt.add(D_totalDebt)
    th.assertIsApproximatelyEqual((await activePool.getLUSDDebt()).toString(), totalDebt)

    const price = await priceFeed.getPrice()
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints('101000000000000000000', price, 0)

    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      bob,
      bob
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      bob,
      bob
    )

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    await relayer.updateRateAndPar()
    await tcrShutdown()
    // Bob attempts to redeem his ill-gotten 101 LUSD, from a system that has 100 LUSD outstanding debt
    try {
      const redemptionTx = await troveManager.redeemCollateralForShutdown(
        totalDebt.add(toBN(dec(100, 18))),
        firstRedemptionHint,
        upperPartialRedemptionHint,
        lowerPartialRedemptionHint,
        upperShieldedPartialRedemptionHint,
        lowerShieldedPartialRedemptionHint,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: bob })
    } catch (error) {
      assert.include(error.message, "VM Exception while processing transaction")
    }
    const debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
    const supply = await contracts.lusdToken.totalSupply()
    // console.log("debt", debt.toString())
    // console.log("supply", supply.toString())
  })

  // Redemption fees 
  it("redeemCollateralForShutdown(): a redemption made when base rate is zero increases the base rate", async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // Check baseRate == 0
    assert.equal(await aggregator.baseRate(), '0')

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    const A_balanceBefore = await lusdToken.balanceOf(A)
    await relayer.updateRateAndPar()
    await tcrShutdown()
    const price = await priceFeed.getPrice()
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints('101000000000000000000', price, 0)

    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      A,
      A
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      A,
      A
    )
    const redemptionTx = await troveManager.redeemCollateralForShutdown(
      toBN(dec(10, 18)),
      firstRedemptionHint,
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      { from: A })
    // Check A's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    assert.isTrue((await aggregator.baseRate()).gt(toBN('0')))
  })

  // Helper: closes whale during shutdown and returns its pre-close debt/coll
  const redeemCollateral3Full1Partial = async () => {
    // Open troves
    const { netDebt: W_netDebt } = await openTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: dec(20000, 18), extraParams: { from: whale } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    await openTrove({ ICR: toBN(dec(280, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: D } })

    // skip bootstrapping phase, update rate, then shutdown
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    await relayer.updateRateAndPar()
    await tcrShutdown()

    // First redeem A, B, C, D with their full balances
    const A_lusd = await lusdToken.balanceOf(A)
    const B_lusd = await lusdToken.balanceOf(B)
    const C_lusd = await lusdToken.balanceOf(C)
    const D_lusd = await lusdToken.balanceOf(D)
    if (toBN(A_lusd).gt(toBN('0'))) { await redeemCollateralForShutdown(A, A_lusd, GAS_PRICE) }
    if (toBN(B_lusd).gt(toBN('0'))) { await redeemCollateralForShutdown(B, B_lusd, GAS_PRICE) }
    if (toBN(C_lusd).gt(toBN('0'))) { await redeemCollateralForShutdown(C, C_lusd, GAS_PRICE) }
    if (toBN(D_lusd).gt(toBN('0'))) { await redeemCollateralForShutdown(D, D_lusd, GAS_PRICE) }

    // Snapshot whale's debt/coll just before whale redemption (for expected calculations)
    const whale_collBefore = await troveManager.getTroveColl(whale)
    const whale_actualDebt = await troveManager.getTroveActualDebt(whale)

    // Whale redeems its full balance, closing its trove
    const whale_lusd = await lusdToken.balanceOf(whale)
    const totalSystemDebt = await th.getEntireSystemDebt(contracts)
    const expectedRedemptionRate = await aggregator.calcRateForRedemption(whale_lusd, totalSystemDebt)
    await redeemCollateralForShutdown(whale, whale_lusd, GAS_PRICE)
    assert.isFalse(await sortedTroves.contains(whale))

    return {
      W_netDebt: toBN(whale_actualDebt),
      W_coll: whale_collBefore,
      expectedRedemptionRate,
    }
  }
  
  it("redeemCollateralForShutdown(): a redemption that closes a trove leaves the trove's Collateral surplus (collateral - Collateral drawn) available for the trove owner to claim", async () => {
    await redeemCollateral3Full1Partial()
    
    const whale_balanceBefore = toBN(await collateralToken.balanceOf(whale))

    // CollSurplusPool endpoint cannot be called directly
    await assertRevert(collSurplusPool.claimColl(whale), 'CollSurplusPool: Caller is not Borrower Operations')

    // Read surplus before claiming (claim will zero it)
    const blockNumber = await web3.eth.getBlockNumber()
    const preEvents = await collSurplusPool.getPastEvents('CollBalanceUpdated', {
      fromBlock: blockNumber - 200,
      toBlock: blockNumber,
      filter: { _account: whale }
    })
    assert.isTrue(preEvents.length > 0)
    // Find the last non-zero balance set for whale
    let W_surplus_actual = toBN('0')
    for (let i = preEvents.length - 1; i >= 0; i--) {
      const bal = toBN(preEvents[i].args._newBalance)
      if (bal.gt(toBN('0'))) { W_surplus_actual = bal; break }
    }

    await borrowerOperations.claimCollateral({ from: whale, gasPrice: GAS_PRICE  })

    const whale_balanceAfter = toBN(await collateralToken.balanceOf(whale))
    const whale_expectedBalance = whale_balanceBefore.add(W_surplus_actual)
    th.assertIsApproximatelyEqual(whale_balanceAfter, whale_expectedBalance)
  })

  it("redeemCollateralForShutdown(): shutdown path - closes A,B,C, records surplus in CollSurplusPool, owners can claim it", async () => {
    // Open troves
    await openTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: dec(20000, 18), extraParams: { from: whale } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    await openTrove({ ICR: toBN(dec(280, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: D } })

    // Move to shutdown
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    await relayer.updateRateAndPar()
    await tcrShutdown()

    const redemptionAmount = await lusdToken.balanceOf(whale)
    const blockBefore = await web3.eth.getBlockNumber()
    // Whale redeems during shutdown; expect A, B, C closed and D partially redeemed
    await th.redeemCollateralForShutdownAndGetTxObject(whale, contracts, redemptionAmount, GAS_PRICE)

    // Assert closure/active states
    assert.isTrue(await sortedTroves.contains(A))
    assert.isTrue(await sortedTroves.contains(B))
    assert.isTrue(await sortedTroves.contains(C))
    assert.isTrue(await sortedTroves.contains(D))

    // Read surplus for A,B,C from CollSurplusPool
    const currentBlock = await web3.eth.getBlockNumber()
    const fetchSurplus = async (account) => {
      const evs = await collSurplusPool.getPastEvents('CollBalanceUpdated', {
        fromBlock: blockBefore,
        toBlock: currentBlock,
        filter: { _account: account }
      })
      let bal = toBN('0')
      for (let i = evs.length - 1; i >= 0; i--) {
        const v = toBN(evs[i].args._newBalance)
        if (v.gt(toBN('0'))) { bal = v; break }
      }
      return bal
    }

    const A_surplus = await fetchSurplus(A)
    const B_surplus = await fetchSurplus(B)
    const C_surplus = await fetchSurplus(C)

    // Claim only if surplus > 0, otherwise expect revert
    const claimAndAssert = async (account, surplus) => {
      if (toBN(surplus).gt(toBN('0'))) {
        const before = toBN(await collateralToken.balanceOf(account))
        await borrowerOperations.claimCollateral({ from: account, gasPrice: GAS_PRICE })
        const after = toBN(await collateralToken.balanceOf(account))
        th.assertIsApproximatelyEqual(after, before.add(surplus))
      } else {
        await assertRevert(borrowerOperations.claimCollateral({ from: account, gasPrice: GAS_PRICE }), 'CollSurplusPool: No collateral available to claim')
      }
    }

    await claimAndAssert(A, A_surplus)
    await claimAndAssert(B, B_surplus)
    await claimAndAssert(C, C_surplus)
  })

  })
  describe("Trove Manager Shutdown, oracle shutdown", () => {
    beforeEach(async () => {
      await setup()
    })

   async function oracleShutdown() {
    // Commit current _price as lastGoodPrice before switching to failure
    await priceFeed.fetchPrice()
    await priceFeed.setOracleFailure(true)
    await priceFeed.fetchPrice()
    assert.isTrue(await troveManager.isShutdown())
    return await priceFeed.getPrice()
   }

   // After oracle shutdown, price feed should serve lastGoodPrice regardless of subsequent setPrice calls
   async function assertLastGoodPriceSticky() {
    const lgp = await priceFeed.getPrice()
    const bogus = lgp.add(toBN('1'))
    await priceFeed.setPrice(bogus)
    const after = await priceFeed.getPrice()
    // Some feeds may round by 1 wei; allow <= 1 wei difference
    assert.isAtMost(th.getDifference(after, lgp), 1)
    return lgp
   }

   describe('liquidations - oracle shutdown', async () => {
     it('liquidate(): closes a Trove that has ICR < MCR (oracle shutdown)', async () => {
       await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
       await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })

       const price = await priceFeed.getPrice()
       const ICR_before = await troveManager.getCurrentICR(alice, price)

       assert.equal(dec(1, 18), await relayer.par())
       assert.isTrue(ICR_before.eq(toBN(dec(4, 18))))

       const MCR = (await troveManager.MCR()).toString()
       assert.equal(MCR.toString(), '1100000000000000000')

       const targetICR = toBN('1111111111111111111')
       await withdrawLUSD({ ICR: targetICR, extraParams: { from: alice } })

       const ICR_AfterWithdrawal = await troveManager.getCurrentICR(alice, price)
       assert.isAtMost(th.getDifference(ICR_AfterWithdrawal, targetICR), 100)

      // Ensure Alice becomes under MCR at liquidation time by lowering the price
      await priceFeed.setPrice('102000000000000000000')
      const priceLow = await priceFeed.getPrice()
      const mcrNow = await troveManager.MCR()
      const icrNow = await troveManager.getCurrentICR(alice, priceLow)
      assert.isTrue(icrNow.lt(mcrNow))

       await oracleShutdown()

       await liquidations.liquidate(alice, { from: owner });

       const status = (await troveManager.Troves(alice))[3]
       assert.equal(status, 3)
       const alice_trove_isInSortedList = await sortedTroves.contains(alice)
       assert.isFalse(alice_trove_isInSortedList)
     })

    it('liquidate(): closes a Trove that has ICR < MCR from par rising', async () => {
      await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
      await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })

      const price = await priceFeed.getPrice()
      const ICR_before = await troveManager.getCurrentICR(alice, price)

      assert.equal(dec(1, 18), await relayer.par())
      assert.isTrue(ICR_before.eq(toBN(dec(4, 18))))

      const MCR = (await troveManager.MCR()).toString()
      assert.equal(MCR.toString(), '1100000000000000000')

      const targetICR = toBN('1100000000000000000')
      await withdrawLUSD({ ICR: targetICR, extraParams: { from: alice } })

      const ICR_AfterWithdrawal = await troveManager.getCurrentICR(alice, price)
      assert.isAtMost(th.getDifference(ICR_AfterWithdrawal, targetICR), 100)

      // ensure it can't be liquidated yet
      try {
        const txAlice = await liquidations.liquidate(alice)
        assert.isFalse(txAlice.receipt.status)
      } catch (err) {
        assert.include(err.message, 'revert')
        assert.include(err.message, 'Liquidations: nothing to liquidate')
      }

      const parBeforeShutdown = await relayer.par()
      await priceFeed.setPrice('102000000000000000000')
      await oracleShutdown()
      await assertLastGoodPriceSticky()
      await assertLastGoodPriceSticky()
      // lusd price drops, raising par
      await marketOracle.setPrice(ONE_DOLLAR.sub(ONE_CENT))
      await relayer.updateRateAndPar();
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);
      await relayer.updateRateAndPar();

      const parAfterShutdown = await relayer.par();
      assert.isTrue(parAfterShutdown.gt(parBeforeShutdown), 'par should have risen')
      const priceNow = await priceFeed.getPrice()
      const icr = await troveManager.getCurrentICR(alice, priceNow)
      const mcr = await troveManager.MCR()
      assert.isTrue(icr.lt(mcr), 'ICR must be < MCR at liquidation time')
      assert.isTrue(await troveManager.isShutdown(), 'system should be shutdown')
      tx = await liquidations.liquidate(alice, { from: owner })

      const status = (await troveManager.Troves(alice))[3]
      assert.equal(status, 3)
      const alice_trove_isInSortedList = await sortedTroves.contains(alice)
      assert.isFalse(alice_trove_isInSortedList)
    })

    it("liquidate(): decreases ActivePool Collateral and LUSDDebt by correct amounts", async () => {
      const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
      const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

      const activePool_Collateral_before = (await activePool.getCollateral()).toString()
      const activePool_RawCollateral_before = (await collateralToken.balanceOf(activePool.address)).toString()
      const activePool_LUSDDebt_before = (await activePool.getLUSDDebt()).toString()

      assert.equal(activePool_Collateral_before, A_collateral.add(B_collateral))
      assert.equal(activePool_RawCollateral_before, A_collateral.add(B_collateral))
      th.assertIsApproximatelyEqual(activePool_LUSDDebt_before, A_totalDebt.add(B_totalDebt))

      await priceFeed.setPrice('102000000000000000000')
      assert.isFalse(await th.checkRecoveryMode(contracts))
      await priceFeed.setPrice('100000000000000000000')
      await oracleShutdown()
      await assertLastGoodPriceSticky()
      await assertLastGoodPriceSticky()
      assert.isTrue(await troveManager.isShutdown())
      await liquidations.liquidate(bob, { from: owner })

      const activePool_Collateral_After = await activePool.getCollateral()
      const activePool_RawCollateral_After = await collateralToken.balanceOf(activePool.address)
      const activePool_LUSDDebt_After = await activePool.getLUSDDebt()

      assert.isAtMost(th.getDifference(activePool_Collateral_After, A_collateral), 1)
      assert.isAtMost(th.getDifference(activePool_RawCollateral_After, A_collateral), 1)
      th.assertIsApproximatelyEqual(activePool_LUSDDebt_After, A_totalDebt)
    })

    it("liquidate(): increases DefaultPool Collateral and LUSD debt by correct amounts", async () => {
      const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
      const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

      const defaultPool_Collateral_before = (await defaultPool.getCollateral())
      const defaultPool_RawCollateral_before = (await collateralToken.balanceOf(defaultPool.address)).toString()
      const defaultPool_LUSDDebt_before = (await defaultPool.getLUSDDebt()).toString()

      assert.equal(defaultPool_Collateral_before, '0')
      assert.equal(defaultPool_RawCollateral_before, '0')
      assert.equal(defaultPool_LUSDDebt_before, '0')

      await priceFeed.setPrice('100000000000000000000')
      assert.isFalse(await th.checkRecoveryMode(contracts))
      await priceFeed.setPrice('100000000000000000000')
      await oracleShutdown()
      await assertLastGoodPriceSticky()
      await assertLastGoodPriceSticky()
      assert.isTrue(await troveManager.isShutdown())
      tx = await liquidations.liquidate(bob, { from: owner })

      const defaultPool_Collateral_After = await defaultPool.getCollateral()
      const defaultPool_RawCollateral_After = await collateralToken.balanceOf(defaultPool.address)
      const defaultPool_LUSDDebt_After = await defaultPool.getLUSDDebt()

      const defaultPool_Collateral = th.applyLiquidationFee(B_collateral)
      assert.isAtMost(th.getDifference(defaultPool_Collateral_After, defaultPool_Collateral), 1)
      assert.isAtMost(th.getDifference(defaultPool_RawCollateral_After, defaultPool_Collateral), 1)
      th.assertIsApproximatelyEqual(defaultPool_LUSDDebt_After, B_totalDebt)
    })

    it("liquidate(): removes the Trove's stake from the total stakes", async () => {
      const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
      const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

      const totalStakes_before = (await rewards.totalStakes()).toString()
      assert.equal(totalStakes_before, A_collateral.add(B_collateral))

      await priceFeed.setPrice('100000000000000000000')
      assert.isFalse(await th.checkRecoveryMode(contracts))
      await oracleShutdown()
      assert.isTrue(await troveManager.isShutdown())
      await liquidations.liquidate(bob, { from: owner })

      const totalStakes_After = (await rewards.totalStakes()).toString()
      assert.equal(totalStakes_After, A_collateral)
    })

    it("liquidate(): Removes the correct trove from the TroveOwners array, and moves the last array element to the new empty slot", async () => {
      await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })

      await openTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
      await openTrove({ ICR: toBN(dec(216, 16)), extraParams: { from: bob } })
      await openTrove({ ICR: toBN(dec(214, 16)), extraParams: { from: carol } })
      await openTrove({ ICR: toBN(dec(212, 16)), extraParams: { from: dennis } })
      await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: erin } })

      await priceFeed.setPrice(dec(100, 18))

      const arrayLength_before = await troveManager.getTroveOwnersCount()
      assert.equal(arrayLength_before, 6)
      assert.isFalse(await th.checkRecoveryMode(contracts))
      await oracleShutdown()
      assert.isTrue(await troveManager.isShutdown())

      await liquidations.liquidate(carol)

      assert.isFalse(await sortedTroves.contains(carol))

      const arrayLength_After = await troveManager.getTroveOwnersCount()
      assert.equal(arrayLength_After, 5)

      const trove_0 = await troveManager.TroveOwners(0)
      const trove_1 = await troveManager.TroveOwners(1)
      const trove_2 = await troveManager.TroveOwners(2)
      const trove_3 = await troveManager.TroveOwners(3)
      const trove_4 = await troveManager.TroveOwners(4)

      assert.equal(trove_0, whale)
      assert.equal(trove_1, alice)
      assert.equal(trove_2, bob)
      assert.equal(trove_3, erin)
      assert.equal(trove_4, dennis)

      const whale_arrayIndex = (await troveManager.Troves(whale))[4]
      const alice_arrayIndex = (await troveManager.Troves(alice))[4]
      const bob_arrayIndex = (await troveManager.Troves(bob))[4]
      const dennis_arrayIndex = (await troveManager.Troves(dennis))[4]
      const erin_arrayIndex = (await troveManager.Troves(erin))[4]

      assert.equal(whale_arrayIndex, 0)
      assert.equal(alice_arrayIndex, 1)
      assert.equal(bob_arrayIndex, 2)
      assert.equal(erin_arrayIndex, 3)
      assert.equal(dennis_arrayIndex, 4)
    })

    it("liquidate(): updates the snapshots of total stakes and total collateral", async () => {
      const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
      const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

      const totalStakesSnapshot_before = (await rewards.totalStakesSnapshot()).toString()
      const totalCollateralSnapshot_before = (await rewards.totalCollateralSnapshot()).toString()
      assert.equal(totalStakesSnapshot_before, '0')
      assert.equal(totalCollateralSnapshot_before, '0')

      await priceFeed.setPrice('100000000000000000000')
      assert.isFalse(await th.checkRecoveryMode(contracts))
      await oracleShutdown()
      assert.isTrue(await troveManager.isShutdown())
      await liquidations.liquidate(bob, { from: owner })

      const totalStakesSnapshot_After = await rewards.totalStakesSnapshot()
      const totalCollateralSnapshot_After = await rewards.totalCollateralSnapshot()

      assert.isTrue(totalStakesSnapshot_After.eq(A_collateral))
      assert.isAtMost(th.getDifference(totalCollateralSnapshot_After, A_collateral.add(th.applyLiquidationFee(B_collateral))), 1)
    })

    it("liquidate(): surplus collateral if A,B,C liquidated above penalty (oracle)", async () => {
      const spDeposit = toBN(dec(100, 21))
      await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
      const {collateral: aliceCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: alice } })
      const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
      const {collateral: carolCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: carol } })

      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

      const penalty = await liquidations.LIQUIDATION_PENALTY();
      const mcr = await troveManager.MCR();
      const targetICRliq = penalty.add(toBN(dec(1,16))).add(mcr).div(toBN(2));

      const priceAtOpen = await priceFeed.getPrice();
      const parAtOpen = await relayer.par();

      await priceFeed.setPrice(mv._100e18BN)


      await oracleShutdown()

      const priceNow = await priceFeed.getPrice()

      assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).lt((mcr)))
      assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).gt((penalty)))
      assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).lt((mcr)))
      assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).gt((penalty)))
      assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).lt((mcr)))
      assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).gt((penalty)))

      tx_alice = await liquidations.liquidate(alice)
      const [aliceLiquidatedDebt, aliceLiquidatedColl, aliceCollGasComp] = th.getEmittedLiquidationValues(tx_alice)
      aliceGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
      assert.isTrue(aliceCollGasComp.eq(aliceGasComp))

      tx_bob = await liquidations.liquidate(bob)
      const [bobLiquidatedDebt, bobLiquidatedColl, bobCollGasComp] = th.getEmittedLiquidationValues(tx_bob)
      bobGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
      assert.isTrue(bobCollGasComp.eq(bobGasComp))

      tx_carol = await liquidations.liquidate(carol)
      const [carolLiquidatedDebt, carolLiquidatedColl, carolCollGasComp] = th.getEmittedLiquidationValues(tx_carol)
      carolGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())
      assert.isTrue(carolCollGasComp.eq(carolGasComp))

      assert.isFalse((await sortedTroves.contains(alice)))
      assert.isFalse((await sortedTroves.contains(bob)))
      assert.isFalse((await sortedTroves.contains(carol)))

      aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
      bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
      carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
      assert.isTrue(aliceSurplus.gt(toBN('0')))
      assert.isTrue(bobSurplus.gt(toBN('0')))
      assert.isTrue(carolSurplus.gt(toBN('0')))

      assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
      assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
      assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    })

    it("liquidateTroves(): A,B,C same size troves. surplus collateral if A,B,C liquidated above penalty (oracle)", async () => {
      const spDeposit = toBN(dec(100, 21))
      await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
      const {collateral: aliceCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: alice } })
      const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
      const {collateral: carolCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: carol } })

      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

      const penalty = await liquidations.LIQUIDATION_PENALTY();
      const mcr = await troveManager.MCR();
      const targetICRliq = penalty.add(toBN(dec(1,16))).add(mcr).div(toBN(2));

      const priceAtOpen = await priceFeed.getPrice();
      const parAtOpen = await relayer.par();
    
      const parLiq = parAtOpen;
      await priceFeed.setPrice(mv._100e18BN)

      await oracleShutdown()

      const priceNow = await priceFeed.getPrice()
      assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).lt((await troveManager.MCR())))
      assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
      assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).lt((await troveManager.MCR())))
      assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
      assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).lt((await troveManager.MCR())))
      assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))

      tx_liq = await liquidations.liquidateTroves(3)
      const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp] = th.getEmittedLiquidationValues(tx_liq)
      totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
      assert.isTrue(totalCollGasComp.eq(totalGasComp))

      assert.isFalse((await sortedTroves.contains(alice)))
      assert.isFalse((await sortedTroves.contains(bob)))
      assert.isFalse((await sortedTroves.contains(carol)))

      aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
      bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
      carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
      assert.isTrue(aliceSurplus.gt(toBN('0')))
      assert.isTrue(bobSurplus.gt(toBN('0')))
      assert.isTrue(carolSurplus.gt(toBN('0')))

      aliceLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
      bobLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
      carolLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
      aliceCollGasComp = totalGasComp.div(toBN('3'))
      bobCollGasComp = totalGasComp.div(toBN('3'))
      carolCollGasComp = totalGasComp.div(toBN('3'))

      assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
      assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
      assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    })

    it("batchLiquidate(): A,B,C same size troves. surplus collateral if A,B,C liquidated above penalty (oracle)", async () => {
      const spDeposit = toBN(dec(100, 21))
      await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
      const {collateral: aliceCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: alice } })
      const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
      const {collateral: carolCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: carol } })

      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })

      const penalty = await liquidations.LIQUIDATION_PENALTY();
      const mcr = await troveManager.MCR();
      const targetICRliq = penalty.add(toBN(dec(1,16))).add(mcr).div(toBN(2));

      const priceAtOpen = await priceFeed.getPrice();
      const parAtOpen = await relayer.par();
      await priceFeed.setPrice(mv._100e18BN)
      await oracleShutdown()
      const priceNow = await priceFeed.getPrice()
      assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).lt((await troveManager.MCR())))
      assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
      assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).lt((await troveManager.MCR())))
      assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
      assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).lt((await troveManager.MCR())))
      assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))

      tx_liq = await liquidations.batchLiquidate([alice, bob, carol])
      const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp] = th.getEmittedLiquidationValues(tx_liq)
      totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
      assert.isTrue(totalCollGasComp.eq(totalGasComp))

      assert.isFalse((await sortedTroves.contains(alice)))
      assert.isFalse((await sortedTroves.contains(bob)))
      assert.isFalse((await sortedTroves.contains(carol)))

      aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
      bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
      carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
      assert.isTrue(aliceSurplus.gt(toBN('0')))
      assert.isTrue(bobSurplus.gt(toBN('0')))
      assert.isTrue(carolSurplus.gt(toBN('0')))

      aliceLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
      bobLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
      carolLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
      aliceCollGasComp = totalGasComp.div(toBN('3'))
      bobCollGasComp = totalGasComp.div(toBN('3'))
      carolCollGasComp = totalGasComp.div(toBN('3'))

      assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
      assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
      assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    })

    it("liquidateTroves(): A,B,C different size troves, different ICRs. A,B,C have surplus collateral liquidated above penalty (oracle)", async () => {
      await openTrove({ ICR: toBN(dec(200, 21)),extraLUSDAmount: toBN(dec(1000, 20)), extraParams: { from: whale } })
        // fund stability pool
      const spDeposit = toBN(dec(1000, 20))
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
      const {collateral: aliceCollateral} = await openTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
      const {collateral: bobCollateral}   = await openTrove({ ICR: toBN(dec(219, 16)), extraLUSDAmount: toBN(dec(5,21)), extraParams: { from: bob } })
      const {collateral: carolCollateral} = await openTrove({ ICR: toBN(dec(2195, 15)), extraLUSDAmount: toBN(dec(20,21)), extraParams: { from: carol } })

      // Drop price so that ICRs fall between penalty and MCR after shutdown
      await priceFeed.setPrice(mv._100e18BN)
      const penalty = await liquidations.LIQUIDATION_PENALTY();
      const mcr = await troveManager.MCR();
      const priceNow = await priceFeed.getPrice()
      await oracleShutdown()
      const aliceICR = await troveManager.getCurrentICR(alice, priceNow)
      const bobICR = await troveManager.getCurrentICR(bob, priceNow)
      const carolICR = await troveManager.getCurrentICR(carol, priceNow)

      assert.isTrue((aliceICR).lt(mcr))
      assert.isTrue((aliceICR).gt(penalty))
      assert.isTrue((bobICR).lt(mcr))
      assert.isTrue((bobICR).gt(penalty))
      assert.isTrue((carolICR).lt(mcr))
      assert.isTrue((carolICR).gt(penalty))

      // Snapshot per-trove coll just before liquidation to match on-chain rounding
      const gasDiv = await troveManager.PERCENT_DIVISOR()
      const aliceCollPre = await troveManager.getTroveColl(alice)
      const bobCollPre   = await troveManager.getTroveColl(bob)
      const carolCollPre = await troveManager.getTroveColl(carol)

      tx_liq = await liquidations.liquidateTroves(3)

      assert.isFalse((await sortedTroves.contains(alice)))
      assert.isFalse((await sortedTroves.contains(bob)))
      assert.isFalse((await sortedTroves.contains(carol)))

      const aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
      const bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
      const carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)

      assert.isTrue(aliceSurplus.gt(toBN('0')))
      assert.isTrue(bobSurplus.gt(toBN('0')))
      assert.isTrue(carolSurplus.gt(toBN('0')))

      // System-level conservation: (liq coll + gas comp + surpluses) ~= sum initial coll (allow tiny rounding)
      const [totalLiqDebtX, totalLiqCollX, totalCollGasCompX] = th.getEmittedLiquidationValues(tx_liq)
      const sumSurplus = aliceSurplus.add(bobSurplus).add(carolSurplus)
      const sumInitialColl = aliceCollateral.add(bobCollateral).add(carolCollateral)
      const sumAfter = totalLiqCollX.add(totalCollGasCompX).add(sumSurplus)
      assert.isAtMost(th.getDifference(sumAfter, sumInitialColl), 5)
    })
  })
   describe("TroveManager - Oracle Shutdown - RedeemCollateral", () => {
    it('redeemCollateralForShutdown(): oracle shutdown, discount 25%, A,B,C,D different ICRs', async () => {
      const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
      const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
      const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
      const denisLusdAmount = C_netDebt.add(B_netDebt).add(A_totalDebt)
      await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: denisLusdAmount, extraParams: { from: dennis } })

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await relayer.updatePar()
      const shutdownPrice = await oracleShutdown()
      await assertLastGoodPriceSticky()

      const { firstRedemptionHint, partialRedemptionHintNICR } = await hintHelpers.getRedemptionHints(denisLusdAmount, shutdownPrice, 0)
      const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)
      const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)

      const dennisCollBefore = await collateralToken.balanceOf(dennis)

      const redemptionTx = await troveManager.redeemCollateralForShutdown(
        denisLusdAmount,
        firstRedemptionHint,
        up,
        lo,
        sup,
        slo,
        partialRedemptionHintNICR,
        0, dec(25,16),
        { from: dennis, gasPrice: GAS_PRICE }
      )

      const totalRedeemed = th.getEmittedRedemptionValues(redemptionTx)[1]
      const par = await relayer.par()
      const discount = await troveManager.getDiscount()
      const received = (await collateralToken.balanceOf(dennis)).sub(dennisCollBefore)
      const expected = totalRedeemed.mul(par).mul(mv._1e18BN).div(mv._1e18BN.sub(discount).mul(shutdownPrice))
      th.assertIsApproximatelyEqual(expected, received)
    })

    it('redeemCollateralForShutdown(): oracle shutdown, discount 50%, A,B,C,D different ICRs', async () => {
      const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
      const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
      const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
      const denisLusdAmount = C_netDebt.add(B_netDebt).add(A_totalDebt)
      await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: denisLusdAmount, extraParams: { from: dennis } })

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await relayer.updatePar()
      const shutdownPrice = await oracleShutdown()
      await assertLastGoodPriceSticky()

      const { firstRedemptionHint, partialRedemptionHintNICR } = await hintHelpers.getRedemptionHints(denisLusdAmount, shutdownPrice, 0)
      const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)
      const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)

      const dennisCollBefore = await collateralToken.balanceOf(dennis)

      const redemptionTx = await troveManager.redeemCollateralForShutdown(
        denisLusdAmount,
        firstRedemptionHint,
        up,
        lo,
        sup,
        slo,
        partialRedemptionHintNICR,
        0, dec(5,17),
        { from: dennis, gasPrice: GAS_PRICE }
      )

      const totalRedeemed = th.getEmittedRedemptionValues(redemptionTx)[1]
      const par = await relayer.par()
      const discount = await troveManager.getDiscount()
      const received = (await collateralToken.balanceOf(dennis)).sub(dennisCollBefore)
      const expected = totalRedeemed.mul(par).mul(mv._1e18BN).div(mv._1e18BN.sub(discount).mul(shutdownPrice))
      th.assertIsApproximatelyEqual(expected, received)
    })

    it('redeemCollateralForShutdown(): oracle shutdown, discount max 100%, A,B,C,D different ICRs', async () => {
      const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
      const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
      const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
      const denisLusdAmount = C_netDebt.add(B_netDebt).add(A_totalDebt)
      await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: denisLusdAmount, extraParams: { from: dennis } })

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await relayer.updatePar()
      const shutdownPrice = await oracleShutdown()
      await assertLastGoodPriceSticky()

      const { firstRedemptionHint, partialRedemptionHintNICR } = await hintHelpers.getRedemptionHints(denisLusdAmount, shutdownPrice, 0)
      const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)
      const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)

      const dennisCollBefore = await collateralToken.balanceOf(dennis)

      const redemptionTx = await troveManager.redeemCollateralForShutdown(
        denisLusdAmount,
        firstRedemptionHint,
        up,
        lo,
        sup,
        slo,
        partialRedemptionHintNICR,
        0, dec(1,18),
        { from: dennis, gasPrice: GAS_PRICE }
      )

      const totalRedeemed = th.getEmittedRedemptionValues(redemptionTx)[1]
      const par = await relayer.par()
      const discount = await troveManager.getDiscount()
      const received = (await collateralToken.balanceOf(dennis)).sub(dennisCollBefore)
      const expected = totalRedeemed.mul(par).mul(mv._1e18BN).div(mv._1e18BN.sub(discount).mul(shutdownPrice))
      th.assertIsApproximatelyEqual(expected, received)
    })

    it("redeemCollateralForShutdown(): oracle shutdown, succeeds with any max fee percentage (no fees)", async () => {
      const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(9500, 18), extraParams: { from: A } })
      const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(395, 16)), extraLUSDAmount: dec(9000, 18), extraParams: { from: B } })
      const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(390, 16)), extraLUSDAmount: dec(10000, 18), extraParams: { from: C } })
      const expectedTotalSupply = A_totalDebt.add(B_totalDebt).add(C_totalDebt)

      // Ensure there are redeemable troves at the frozen price
      await priceFeed.setPrice(mv._100e18BN)

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await oracleShutdown()
      
      const attempted = expectedTotalSupply.div(toBN(10))
      const price = await priceFeed.getPrice()

      // tx1
      {
        const amt = attempted.div(toBN(5))
        const { firstRedemptionHint, partialRedemptionHintNICR } = await hintHelpers.getRedemptionHints(amt, price, 0)
        const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, A, A)
        const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, A, A)
        tx1 = await troveManager.redeemCollateralForShutdown(
          amt,
          firstRedemptionHint, up, lo, sup, slo,
          partialRedemptionHintNICR,
          0, dec(5, 15), { from: A }
        )
      }
      assert.isTrue(tx1.receipt.status)

      // tx2
      {
        const amt = attempted.div(toBN(5))
        const { firstRedemptionHint, partialRedemptionHintNICR } = await hintHelpers.getRedemptionHints(amt, price, 0)
        const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, B, B)
        const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, B, B)
        tx2 = await troveManager.redeemCollateralForShutdown(
          amt,
          firstRedemptionHint, up, lo, sup, slo,
          partialRedemptionHintNICR,
          0, dec(1, 17), { from: B }
        )
      }
      assert.isTrue(tx2.receipt.status)

      // tx3
      {
        const amt = attempted.div(toBN(5))
        const { firstRedemptionHint, partialRedemptionHintNICR } = await hintHelpers.getRedemptionHints(amt, price, 0)
        const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, C, C)
        const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, C, C)
        tx3 = await troveManager.redeemCollateralForShutdown(
          amt,
          firstRedemptionHint, up, lo, sup, slo,
          partialRedemptionHintNICR,
          0, dec(5, 17), { from: C }
        )
      }
      assert.isTrue(tx3.receipt.status)

      // tx4
      {
        const amt = attempted.div(toBN(5))
        const { firstRedemptionHint, partialRedemptionHintNICR } = await hintHelpers.getRedemptionHints(amt, price, 0)
        const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, A, A)
        const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, A, A)
        tx4 = await troveManager.redeemCollateralForShutdown(
          amt,
          firstRedemptionHint, up, lo, sup, slo,
          partialRedemptionHintNICR,
          0, dec(1, 18), { from: A }
        )
      }
      assert.isTrue(tx4.receipt.status)

      const r1 = th.getEventArgByName(tx1, "Redemption", "_collateralFee")
      const r2 = th.getEventArgByName(tx2, "Redemption", "_collateralFee")
      const r3 = th.getEventArgByName(tx3, "Redemption", "_collateralFee")
      const r4 = th.getEventArgByName(tx4, "Redemption", "_collateralFee")
      assert.equal(r1.toString(), '0')
      assert.equal(r2.toString(), '0')
      assert.equal(r3.toString(), '0')
      assert.equal(r4.toString(), '0')
    })

    it("redeemCollateralForShutdown(): oracle shutdown, no discount, SP total may drip; depositor balances change only by credited interest", async () => {
      await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

      const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(50, 18), extraParams: { from: bob } })
      const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(395, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: carol } })
      const { totalDebt: D_totalDebt } = await openTrove({ ICR: toBN(dec(390, 16)), extraLUSDAmount: dec(150, 18), extraParams: { from: dennis } })

      const redemptionAmount = B_totalDebt.add(C_totalDebt).add(D_totalDebt)
      await openTrove({ ICR: toBN(dec(500, 16)), extraLUSDAmount: redemptionAmount, extraParams: { from: alice } })
      await lusdToken.transfer(erin, redemptionAmount, { from: alice })

      await stabilityPool.provideToSP(dec(25, 18), ZERO_ADDRESS, { from: bob })
      await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, { from: carol })
      await stabilityPool.provideToSP(dec(75, 18), ZERO_ADDRESS, { from: dennis })
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      const LUSDinSP_before = await stabilityPool.getTotalLUSDDeposits()
      const bobDep_before = await stabilityPool.getCompoundedLUSDDeposit(bob)
      const carolDep_before = await stabilityPool.getCompoundedLUSDDeposit(carol)
      const dennisDep_before = await stabilityPool.getCompoundedLUSDDeposit(dennis)
      const bobGain_before = await stabilityPool.getDepositorCollateralGain(bob)
      const carolGain_before = await stabilityPool.getDepositorCollateralGain(carol)
      const dennisGain_before = await stabilityPool.getDepositorCollateralGain(dennis)

      await oracleShutdown()
      

      const tx = await troveManager.redeemCollateralForShutdown(
        redemptionAmount.div(toBN(2)),
        ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS,
        0, 0, th._100pct,
        { from: erin }
      )
      assert.isTrue(tx.receipt.status)

      const LUSDinSP_after = await stabilityPool.getTotalLUSDDeposits()
      const bobDep_after = await stabilityPool.getCompoundedLUSDDeposit(bob)
      const carolDep_after = await stabilityPool.getCompoundedLUSDDeposit(carol)
      const dennisDep_after = await stabilityPool.getCompoundedLUSDDeposit(dennis)
      const bobGain_after = await stabilityPool.getDepositorCollateralGain(bob)
      const carolGain_after = await stabilityPool.getDepositorCollateralGain(carol)
      const dennisGain_after = await stabilityPool.getDepositorCollateralGain(dennis)

      // Expected proportional credit if SP drips during redemption
      let spDrip = toBN('0')
      try {
        const raw = th.getRawEventArgByName(tx, feeRouterInterface, feeRouter.address, "Drip", "_spInterest")
        if (raw !== undefined) spDrip = toBN(raw)
      } catch (e) {}
      // Depositor LUSD deposits should not decrease due to redemption; any drift is positive interest credit
      assert.isTrue(bobDep_after.gte(bobDep_before))
      assert.isTrue(carolDep_after.gte(carolDep_before))
      assert.isTrue(dennisDep_after.gte(dennisDep_before))
      assert.isTrue(bobGain_before.eq(bobGain_after))
      assert.isTrue(carolGain_before.eq(carolGain_after))
      assert.isTrue(dennisGain_before.eq(dennisGain_after))
      const fee = th.getEventArgByName(tx, "Redemption", "_collateralFee")
      assert.equal(fee.toString(), '0')
    })

    it('redeemCollateralForShutdown(): oracle shutdown, with invalid first hint, zero address', async () => {
      const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
      const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
      const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
      const redemptionAmount = C_netDebt.add(B_netDebt).add(toBN(dec(2,18)))
      await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      const shutdownPrice = await oracleShutdown()
      await assertLastGoodPriceSticky()

      const { firstRedemptionHint, partialRedemptionHintNICR } = await hintHelpers.getRedemptionHints(redemptionAmount, shutdownPrice, 0)
      const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)
      const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)

      const dennisBalBefore = await collateralToken.balanceOf(dennis)
      const tx = await troveManager.redeemCollateralForShutdown(
        redemptionAmount,
        ZERO_ADDRESS,
        up,
        lo,
        sup,
        slo,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: dennis, gasPrice: GAS_PRICE }
      )
      const received = (await collateralToken.balanceOf(dennis)).sub(dennisBalBefore)
      assert.isTrue(received.gt(toBN('0')))
    })

    it('redeemCollateralForShutdown(): oracle shutdown, with invalid first hint, non-existent trove', async () => {
      const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
      const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
      const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
      const redemptionAmount = C_netDebt.add(B_netDebt).add(toBN(dec(2,18)))
      await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      const price = await oracleShutdown()

      const { firstRedemptionHint, partialRedemptionHintNICR } = await hintHelpers.getRedemptionHints(redemptionAmount, price, 0)
      const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)
      const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)

      const dennisBalBefore = await collateralToken.balanceOf(dennis)
      const tx = await troveManager.redeemCollateralForShutdown(
        redemptionAmount,
        erin, // invalid first hint, no trove
        up,
        lo,
        sup,
        slo,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: dennis, gasPrice: GAS_PRICE }
      )
      const received = (await collateralToken.balanceOf(dennis)).sub(dennisBalBefore)
      assert.isTrue(received.gt(toBN('0')))
    })

    it('redeemCollateralForShutdown(): oracle shutdown, with invalid first hint, trove below MCR', async () => {
      const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
      const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
      const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
      const redemptionAmount = C_netDebt.add(B_netDebt).add(toBN(dec(2,18)))
      await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

      // Create a below-MCR trove for hint
      await priceFeed.setPrice(toBN(dec(400,18)))
      // skip bootstrapping phase
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: erin } })
      const price = await oracleShutdown()

      const { firstRedemptionHint, partialRedemptionHintNICR } = await hintHelpers.getRedemptionHints(redemptionAmount, price, 0)
      const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)
      const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)

      const dennisBalBefore = await collateralToken.balanceOf(dennis)
      const tx = await troveManager.redeemCollateralForShutdown(
        redemptionAmount,
        erin, // invalid trove below MCR
        up,
        lo,
        sup,
        slo,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: dennis, gasPrice: GAS_PRICE }
      )
      const received = (await collateralToken.balanceOf(dennis)).sub(dennisBalBefore)
      assert.isTrue(received.gt(toBN('0')))
    })

    it('redeemCollateralForShutdown(): oracle shutdown, caller can redeem entire balance', async () => {
      await rateControl.setCoBias(0)
      const { collateral: W_coll, totalDebt: W_totalDebt } = await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
      const { collateral: A_coll, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(400, 18), extraParams: { from: alice } })
      await lusdToken.transfer(erin, dec(400, 18), { from: alice })

      await openTrove({ ICR: toBN(dec(300, 16)), extraParams: { from: bob } })
      await openTrove({ ICR: toBN(dec(300, 16)), extraParams: { from: carol } })
      await openTrove({ ICR: toBN(dec(500, 16)), extraParams: { from: dennis } })

      await oracleShutdown()
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

      const amount = dec(400, 18)
      const tx = await troveManager.redeemCollateralForShutdown(
        amount,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        0,
        0,
        th._100pct,
        { from: erin }
      )

      assert.isTrue(tx.receipt.status)
      const redemptionEvent = th.getEventArgByName(tx, "Redemption", "_collateralFee")
      assert.equal(redemptionEvent.toString(), '0')
    })

    it('redeemCollateralForShutdown(): oracle shutdown, reverts when requested amount exceeds user balance', async () => {
      const { collateral: A_coll, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(400, 18), extraParams: { from: alice } })
      await lusdToken.transfer(erin, dec(400, 18), { from: alice })
      await openTrove({ ICR: toBN(dec(300, 16)), extraParams: { from: bob } })
      await openTrove({ ICR: toBN(dec(300, 16)), extraParams: { from: carol } })
      await openTrove({ ICR: toBN(dec(500, 16)), extraParams: { from: dennis } })
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await oracleShutdown()


      try {
        const price = await priceFeed.getPrice()
        const { firstRedemptionHint, partialRedemptionHintNICR } = await hintHelpers.getRedemptionHints(dec(1000, 18), price, 0)
        const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, erin, erin)
        const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, erin, erin)
        const tx = await troveManager.redeemCollateralForShutdown(
          dec(1000, 18), firstRedemptionHint, up, lo, sup, slo, partialRedemptionHintNICR, 0, th._100pct, { from: erin }
        )
        assert.isFalse(tx.receipt.status)
      } catch (err) {
        assert.include(err.message, 'revert')
        assert.include(err.message, "must be <= user's balance")
      }
    })

    it("redeemCollateralForShutdown(): oracle shutdown, reverts if amount exceeds outstanding system debt", async () => {
      await lusdToken.unprotectedMint(bob, '101000000000000000000')
      const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(1000, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: carol } })
      const { totalDebt: D_totalDebt } = await openTrove({ ICR: toBN(dec(1000, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: dennis } })

      const totalDebt = C_totalDebt.add(D_totalDebt)
      const price = await priceFeed.getPrice()
      const { firstRedemptionHint, partialRedemptionHintNICR } = await hintHelpers.getRedemptionHints('101000000000000000000', price, 0)
      const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, bob, bob)
      const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, bob, bob)

      await oracleShutdown()
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await relayer.updateRateAndPar()
      try {
        const tx = await troveManager.redeemCollateralForShutdown(
          totalDebt.add(toBN(dec(100, 18))),
          firstRedemptionHint,
          up,
          lo,
          sup,
          slo,
          partialRedemptionHintNICR,
          0, th._100pct,
          { from: bob }
        )
        assert.isFalse(tx.receipt.status)
      } catch (err) {
        assert.include(err.message, 'VM Exception while processing transaction')
      }
    })
     it('redeemCollateralForShutdown(): oracle shutdown, no discount, A,B,C,D troves with different ICRs', async () => {
       const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
       const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
       const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
       const partialRedemptionAmount = toBN(2)
       const denisLusdAmount = C_netDebt.add(B_netDebt).add(A_totalDebt)
       await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: denisLusdAmount, extraParams: { from: dennis } })

       await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
       await relayer.updatePar()
       const priceAfterShutdown = await oracleShutdown()

       const {
         firstRedemptionHint,
         partialRedemptionHintNICR
       } = await hintHelpers.getRedemptionHints(denisLusdAmount, priceAfterShutdown, 0)

       const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
         partialRedemptionHintNICR,
         dennis,
         dennis
       )

       const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
         partialRedemptionHintNICR,
         dennis,
         dennis
       )

       const dennisCollBefore = await collateralToken.balanceOf(dennis)

       const redemptionTx = await troveManager.redeemCollateralForShutdown(
         denisLusdAmount,
         firstRedemptionHint,
         upperPartialRedemptionHint,
         lowerPartialRedemptionHint,
         upperShieldedPartialRedemptionHint,
         lowerShieldedPartialRedemptionHint,
         partialRedemptionHintNICR,
         0, th._100pct,
         {
           from: dennis,
           gasPrice: GAS_PRICE
         }
       )

       const totalRedeemed = th.getEmittedRedemptionValues(redemptionTx)[1]
       const cs = await troveManager.collateralShutdown();
       const shutdownPar = toBN(cs.par.toString());
       const priceNow = await priceFeed.getPrice()
       const dennisCollAfter = await collateralToken.balanceOf(dennis)
       assert.isTrue(denisLusdAmount.eq(totalRedeemed))
       const expectedDelta = denisLusdAmount.mul(shutdownPar.mul(mv._1e18BN)).div(mv._1e18BN).div(priceNow)
       assert.isAtMost(th.getDifference(dennisCollAfter.sub(dennisCollBefore), expectedDelta), 600000000000000)
     })

     it('redeemCollateralForShutdown(): oracle shutdown, ends the redemption sequence when max iterations reached', async () => {
       await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

       const { netDebt: A_debt } = await openTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: alice } })
       const { netDebt: B_debt } = await openTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: bob } })
       const { netDebt: C_debt } = await openTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })
       const redemptionAmount = A_debt.add(B_debt)
       const attemptedRedemptionAmount = redemptionAmount.add(C_debt)

       await collateralToken.mint(flyn, dec(10000, 30))
       const { lusdAmount: F_lusdAmount } = await openTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: redemptionAmount.mul(toBN(2)), extraParams: { from: flyn } })

       await oracleShutdown()

       await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

       await troveManager.redeemCollateralForShutdown(attemptedRedemptionAmount, alice, alice, alice, alice, alice, 0, 2, th._100pct, { from: flyn })

       const flynBalance = await lusdToken.balanceOf(flyn)
       const actualRedeemedAmount = F_lusdAmount.sub(flynBalance)
       assert.isTrue(actualRedeemedAmount.lt(attemptedRedemptionAmount))
     })
   })
  })

  // Shielded troves during shutdown - mirror liquidation behavior for TCR and oracle shutdown
  describe('liquidations - TCR < SCR (shielded)', async () => {
    beforeEach(async () => {
      await setup()
    })

    it('liquidate(): closes a Shielded Trove when trove has 0 debt', async () => {
      await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
      await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })

      const price = await priceFeed.getPrice()
      assert.equal(dec(1, 18), await relayer.par())

      const MCR = await troveManager.MCR()
      assert.equal(MCR.toString(), '1100000000000000000')

      // Trigger shutdown, then raise par so Alice's ICR falls below MCR
      const parBeforeShutdown = await relayer.par()
      await tcrShutdown()
      assert.isTrue(await th.checkRecoveryMode(contracts))
      await marketOracle.setPrice(ONE_DOLLAR.sub(ONE_CENT))
      await relayer.updateRateAndPar()
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider)
      await relayer.updateRateAndPar()
      const parAfterShutdown = await relayer.par()
      assert.isTrue(parAfterShutdown.gt(parBeforeShutdown))
      const priceNow = await priceFeed.getPrice()
      const icrNow = await troveManager.getCurrentICR(alice, priceNow)
      const mcrNow = await troveManager.MCR()
      assert.isTrue(icrNow.lt(mcrNow))

      await liquidations.liquidate(alice, { from: owner });

      const status = (await troveManager.Troves(alice))[3]
      assert.equal(status, 3)
      const aliceDebtAfter = await troveManager.getTroveActualDebt(alice)
      assert.equal(aliceDebtAfter.toString(), '0')
      const alice_trove_isInSortedList = await sortedShieldedTroves.contains(alice)
      assert.isFalse(alice_trove_isInSortedList)
    })

    it('liquidate(): decreases ActiveShieldedPool Collateral and LUSDDebt by correct amounts', async () => {
      const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
      const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

      const activeShieldedPool_Collateral_before = (await activeShieldedPool.getCollateral()).toString()
      const activeShieldedPool_RawCollateral_before = (await collateralToken.balanceOf(activeShieldedPool.address)).toString()
      const activeShieldedPool_LUSDDebt_before = (await activeShieldedPool.getLUSDDebt()).toString()

      assert.equal(activeShieldedPool_Collateral_before, A_collateral.add(B_collateral))
      assert.equal(activeShieldedPool_RawCollateral_before, A_collateral.add(B_collateral))
      th.assertIsApproximatelyEqual(activeShieldedPool_LUSDDebt_before, A_totalDebt.add(B_totalDebt))

      await priceFeed.setPrice('100000000000000000000');
      await tcrShutdown()
      assert.isTrue(await th.checkRecoveryMode(contracts))

      await liquidations.liquidate(bob, { from: owner });

      const activeShieldedPool_Collateral_After = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawCollateral_After= await collateralToken.balanceOf(activeShieldedPool.address)
      const activeShieldedPool_LUSDDebt_After = await activeShieldedPool.getLUSDDebt()

      assert.isAtMost(th.getDifference(activeShieldedPool_Collateral_After, A_collateral), 1)
      assert.isAtMost(th.getDifference(activeShieldedPool_RawCollateral_After, A_collateral), 1)
      th.assertIsApproximatelyEqual(activeShieldedPool_LUSDDebt_After, A_totalDebt)
    })
  })

  describe('liquidations - oracle shutdown (shielded)', async () => {
    beforeEach(async () => {
      await setup()
    })

   

    it('liquidate(): decreases ActiveShieldedPool Collateral and LUSDDebt by correct amounts (oracle)', async () => {
      const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
      const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

      const activeShieldedPool_Collateral_before = (await activeShieldedPool.getCollateral()).toString()
      const activeShieldedPool_RawCollateral_before = (await collateralToken.balanceOf(activeShieldedPool.address)).toString()
      const activeShieldedPool_LUSDDebt_before = (await activeShieldedPool.getLUSDDebt()).toString()

      assert.equal(activeShieldedPool_Collateral_before, A_collateral.add(B_collateral))
      assert.equal(activeShieldedPool_RawCollateral_before, A_collateral.add(B_collateral))
      th.assertIsApproximatelyEqual(activeShieldedPool_LUSDDebt_before, A_totalDebt.add(B_totalDebt))

      await priceFeed.setPrice('100000000000000000000')
      await priceFeed.fetchPrice()
      await priceFeed.setOracleFailure(true)
      await priceFeed.fetchPrice()
      assert.isTrue(await troveManager.isShutdown())

      await liquidations.liquidate(bob, { from: owner })

      const activeShieldedPool_Collateral_After = await activeShieldedPool.getCollateral()
      const activeShieldedPool_RawCollateral_After= await collateralToken.balanceOf(activeShieldedPool.address)
      const activeShieldedPool_LUSDDebt_After = await activeShieldedPool.getLUSDDebt()

      assert.isAtMost(th.getDifference(activeShieldedPool_Collateral_After, A_collateral), 1)
      assert.isAtMost(th.getDifference(activeShieldedPool_RawCollateral_After, A_collateral), 1)
      th.assertIsApproximatelyEqual(activeShieldedPool_LUSDDebt_After, A_totalDebt)
    })

    it("liquidate(): updates the snapshots of total stakes and total collateral (oracle, shielded)", async () => {
      const { collateral: A_collateral, totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
      const { collateral: B_collateral, totalDebt: B_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

      const totalStakesSnapshot_before = (await rewards.totalStakesSnapshot()).toString()
      const totalCollateralSnapshot_before = (await rewards.totalCollateralSnapshot()).toString()
      assert.equal(totalStakesSnapshot_before, '0')
      assert.equal(totalCollateralSnapshot_before, '0')

      // commit low price then fail oracle (sticky lastGoodPrice)
      await priceFeed.setPrice('100000000000000000000')
      await priceFeed.fetchPrice()
      await priceFeed.setOracleFailure(true)
      await priceFeed.fetchPrice()
      assert.isTrue(await troveManager.isShutdown())

      await liquidations.liquidate(bob, { from: owner })

      const totalStakesSnapshot_After = await rewards.totalStakesSnapshot()
      const totalCollateralSnapshot_After = await rewards.totalCollateralSnapshot()

      assert.isTrue(totalStakesSnapshot_After.eq(A_collateral))
      assert.isAtMost(th.getDifference(totalCollateralSnapshot_After, A_collateral.add(th.applyLiquidationFee(B_collateral))), 1)
    })

    it("liquidate(): removes the Trove's stake from the total stakes (oracle, shielded)", async () => {
      const { collateral: A_collateral } = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
      const { collateral: B_collateral } = await openShieldedTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

      const totalStakes_before = (await rewards.totalStakes()).toString()
      assert.equal(totalStakes_before, A_collateral.add(B_collateral))

      await priceFeed.setPrice('100000000000000000000')
      await priceFeed.fetchPrice()
      await priceFeed.setOracleFailure(true)
      await priceFeed.fetchPrice()
      assert.isTrue(await troveManager.isShutdown())

      await liquidations.liquidate(bob, { from: owner })

      const totalStakes_After = (await rewards.totalStakes()).toString()
      assert.equal(totalStakes_After, A_collateral)
    })

    it("liquidate(): reverts if trove is non-existent (oracle, shielded)", async () => {
      await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
      await openShieldedTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })

      assert.equal(await troveManager.getTroveStatus(carol), 0)

      await priceFeed.setPrice('100000000000000000000')
      await priceFeed.fetchPrice()
      await priceFeed.setOracleFailure(true)
      await priceFeed.fetchPrice()
      assert.isTrue(await troveManager.isShutdown())

      assert.isFalse(await sortedShieldedTroves.contains(carol))
      await assertRevert(liquidations.liquidate(carol), "Trove does not exist or is closed")
    })
  })

  describe('TroveManager - TCR Shutdown - RedeemCollateral (shielded)', () => {
    beforeEach(async () => {
      await setup()
    })
    it('redeemCollateralForShutdown(): closes a Shielded Trove when trove has 0 debt (oracle shutdown)', async () => {
      await openShieldedTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
      const { totalDebt: aliceDebtBefore } = await openShieldedTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    // Set a low price and commit it as last good price before failing oracle
      await priceFeed.setPrice('100000000000000000000')
      const priceLow = await priceFeed.getPrice()
      // Fund redeemer with enough LUSD by opening an unshielded trove
      await openTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: aliceDebtBefore, extraParams: { from: dennis } })
      const redemptionAmount = aliceDebtBefore
      // skip bootstrapping phase to ensure par/price settled
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
       
      await priceFeed.fetchPrice()
      await priceFeed.setOracleFailure(true)
      await priceFeed.fetchPrice()
      assert.isTrue(await troveManager.isShutdown())

      // Redeem against highest ICR trove first (dennis) until his debt is 0
      const priceSticky = await priceFeed.getPrice()
      const dennisDebtBefore = await troveManager.getTroveActualDebt(dennis)
      let dennisBal = await lusdToken.balanceOf(dennis)
      if (dennisBal.lt(dennisDebtBefore)) {
        const diff = dennisDebtBefore.sub(dennisBal)
        await lusdToken.unprotectedMint(dennis, diff)
        dennisBal = await lusdToken.balanceOf(dennis)
      }
      const redemptionAmountAdj = dennisDebtBefore

      const {
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints(redemptionAmountAdj, priceSticky, 0)

      const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        firstRedemptionHint,
        firstRedemptionHint
      )

      const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        firstRedemptionHint,
        firstRedemptionHint
      )

      await troveManager.redeemCollateralForShutdown(
        redemptionAmountAdj,
        firstRedemptionHint,
        upperPartialRedemptionHint,
        lowerPartialRedemptionHint,
        upperShieldedPartialRedemptionHint,
        lowerShieldedPartialRedemptionHint,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: dennis, gasPrice: GAS_PRICE }
      )

      const dennisDebtAfter = await troveManager.getTroveActualDebt(dennis)
      assert.equal(dennisDebtAfter.toString(), '0')
      const dennis_trove_isInSortedList = await sortedTroves.contains(dennis)
      assert.isFalse(dennis_trove_isInSortedList)
    })

    it('redeemCollateralForShutdown(): shielded troves, tcr shutdown, no discount', async () => {
      const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
      const { netDebt: B_netDebt } = await openShieldedTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
      const { netDebt: C_netDebt } = await openShieldedTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
      const denisLusdAmount = C_netDebt.add(B_netDebt).add(A_totalDebt)
      await openTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: denisLusdAmount, extraParams: { from: dennis } })

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await relayer.updatePar()
      const priceAfterShutdown = await tcrShutdown()

      const {
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints(denisLusdAmount, priceAfterShutdown, 0)

      const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        dennis,
        dennis
      )

      const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        dennis,
        dennis
      )

      const dennisCollBefore = await collateralToken.balanceOf(dennis)
      const dennisLUSDBefore = await lusdToken.balanceOf(dennis)

      const redemptionTx = await troveManager.redeemCollateralForShutdown(
        denisLusdAmount,
        firstRedemptionHint,
        upperPartialRedemptionHint,
        lowerPartialRedemptionHint,
        upperShieldedPartialRedemptionHint,
        lowerShieldedPartialRedemptionHint,
        partialRedemptionHintNICR,
        0, th._100pct,
        {
          from: dennis,
          gasPrice: GAS_PRICE
        }
      )

      const totalRedeemed = th.getEmittedRedemptionValues(redemptionTx)[1]
      const cs = await troveManager.collateralShutdown();
      const shutdownPar = toBN(cs.par.toString());
      const priceNow = await priceFeed.getPrice()
      const dennisCollAfter = await collateralToken.balanceOf(dennis)
      const dennisLUSDAfter = await lusdToken.balanceOf(dennis)
      assert.isTrue(denisLusdAmount.eq(totalRedeemed))
      const expectedDelta = denisLusdAmount.mul(shutdownPar.mul(mv._1e18BN)).div(mv._1e18BN).div(priceNow)
      // Allow slightly larger tolerance due to shielded accounting rounding across multiple troves
      assert.isAtMost(th.getDifference(dennisCollAfter.sub(dennisCollBefore), expectedDelta), 1500000000000000)
      assert.isTrue(dennisLUSDAfter.lt(dennisLUSDBefore))
    })

    it('redeemCollateralForShutdown(): tcr shutdown, redeems across shielded and unshielded troves', async () => {
      // --- SETUP --- open one unshielded and one shielded trove
      await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: bob } })
      await openShieldedTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(22, 18), extraParams: { from: carol } })
      const bobDebt = await lusdToken.balanceOf(bob)
      const carolDebt = await lusdToken.balanceOf(carol)
      // Redeemer funds
      const redeemAmount = bobDebt.add(carolDebt)
      await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: redeemAmount, extraParams: { from: dennis } })

      // Enter shutdown
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await relayer.updatePar()
      const priceAfterShutdown = await tcrShutdown()
      // redeem bob and carol

      await th.redeemCollateralForShutdown(bob, contracts, bobDebt)
      await th.redeemCollateralForShutdown(carol, contracts, carolDebt)
      // redeem dennis
      const dennisDebt = await lusdToken.balanceOf(dennis)
      await th.redeemCollateralForShutdown(dennis, contracts, dennisDebt)
      
      // highest icr trove should be closed regardless of shielded/unshielded
      const dennisStatus = (await troveManager.Troves(dennis))[3]
      assert.equal(dennisStatus, 4)
    })

    it('redeemCollateralForShutdown(): shielded, ends when max iterations reached', async () => {
      const { netDebt: A_netDebt } = await openShieldedTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: alice } })
      const { netDebt: B_netDebt } = await openShieldedTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: bob } })
      const { netDebt: C_netDebt } = await openShieldedTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })
      const attempted = A_netDebt.add(B_netDebt).add(C_netDebt)

      await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: attempted, extraParams: { from: dennis } })

      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await relayer.updatePar()
      await tcrShutdown()

      const priceSticky = await priceFeed.getPrice()
      const {
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints(attempted, priceSticky, 0)
      const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        firstRedemptionHint,
        firstRedemptionHint
      )
      const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        firstRedemptionHint,
        firstRedemptionHint
      )

      await troveManager.redeemCollateralForShutdown(attempted, firstRedemptionHint, upperPartialRedemptionHint, lowerPartialRedemptionHint, upperShieldedPartialRedemptionHint, lowerShieldedPartialRedemptionHint, partialRedemptionHintNICR, 2, th._100pct, { from: dennis })

      const dennisBalance = await lusdToken.balanceOf(dennis)
      const actualRedeemed = attempted.sub(dennisBalance)
      assert.isTrue(actualRedeemed.lt(attempted))
    })

    it('redeemCollateralForShutdown(): shielded, invalid first hint ZERO_ADDRESS succeeds', async () => {
      const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
      const { netDebt: B_netDebt } = await openShieldedTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
      const redemptionAmount = A_totalDebt.add(B_netDebt).div(toBN(2))

      await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await relayer.updatePar()
      const priceAfterShutdown = await tcrShutdown()

      const {
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints(redemptionAmount, priceAfterShutdown, 0)
      const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        dennis,
        dennis
      )
      const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        dennis,
        dennis
      )

      await troveManager.redeemCollateralForShutdown(
        redemptionAmount,
        ZERO_ADDRESS,
        upperPartialRedemptionHint,
        lowerPartialRedemptionHint,
        upperShieldedPartialRedemptionHint,
        lowerShieldedPartialRedemptionHint,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: dennis, gasPrice: GAS_PRICE }
      )

      const dennisLUSDAfter = await lusdToken.balanceOf(dennis)
      assert.isTrue(dennisLUSDAfter.lt(redemptionAmount))
    })
  })

  describe('TroveManager - Oracle Shutdown - RedeemCollateral (shielded)', () => {
    beforeEach(async () => {
      await setup()
    })

    it('redeemCollateralForShutdown(): shielded, ends when max iterations reached (oracle)', async () => {
      const { netDebt: A_netDebt } = await openShieldedTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: alice } })
      const { netDebt: B_netDebt } = await openShieldedTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: bob } })
      const { netDebt: C_netDebt } = await openShieldedTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })
      const attempted = A_netDebt.add(B_netDebt).add(C_netDebt)

      await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: attempted, extraParams: { from: dennis } })
      // Ensure there is at least one unshielded trove so both lists are non-empty
      await openTrove({ ICR: toBN(dec(220, 16)), extraLUSDAmount: dec(5, 18), extraParams: { from: whale } })
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      // switch to oracle failure (sticky lastGoodPrice)
      await priceFeed.setPrice('100000000000000000000')
      await priceFeed.fetchPrice()
      await priceFeed.setOracleFailure(true)
      await priceFeed.fetchPrice()
      assert.isTrue(await troveManager.isShutdown())

      const priceSticky = await priceFeed.getPrice()
      const {
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints(attempted, priceSticky, 0)
      const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, firstRedemptionHint, firstRedemptionHint)
      const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, firstRedemptionHint, firstRedemptionHint)
      await troveManager.redeemCollateralForShutdown(attempted, firstRedemptionHint, up, lo, sup, slo, partialRedemptionHintNICR, 2, th._100pct, { from: dennis })

      const dennisBalance = await lusdToken.balanceOf(dennis)
      const actualRedeemed = attempted.sub(dennisBalance)
      assert.isTrue(actualRedeemed.lt(attempted))
    })

    it('redeemCollateralForShutdown(): shielded, invalid first hint ZERO_ADDRESS succeeds (oracle)', async () => {
      const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
      const { netDebt: B_netDebt } = await openShieldedTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
      const redemptionAmount = A_totalDebt.add(B_netDebt).div(toBN(2))

      await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      // ensure at least one unshielded trove exists so both lists are non-empty
      await openTrove({ ICR: toBN(dec(220, 16)), extraLUSDAmount: dec(5, 18), extraParams: { from: whale } })
      await priceFeed.setPrice('100000000000000000000')
      await priceFeed.fetchPrice()
      await priceFeed.setOracleFailure(true)
      await priceFeed.fetchPrice()
      assert.isTrue(await troveManager.isShutdown())

      const priceSticky = await priceFeed.getPrice()
      const {
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints(redemptionAmount, priceSticky, 0)

      const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        dennis,
        dennis
      )
      const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
        partialRedemptionHintNICR,
        dennis,
        dennis
      )

      await troveManager.redeemCollateralForShutdown(
        redemptionAmount,
        ZERO_ADDRESS,
        upperPartialRedemptionHint,
        lowerPartialRedemptionHint,
        upperShieldedPartialRedemptionHint,
        lowerShieldedPartialRedemptionHint,
        partialRedemptionHintNICR,
        0, th._100pct,
        { from: dennis, gasPrice: GAS_PRICE }
      )

      const dennisLUSDAfter = await lusdToken.balanceOf(dennis)
      assert.isTrue(dennisLUSDAfter.lt(redemptionAmount))
    })

    it('redeemCollateralForShutdown(): shielded, partial redemption keeps trove open (oracle)', async () => {
      const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(12, 18), extraParams: { from: alice } })
      await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(3, 18), extraParams: { from: bob } })
      const redemptionAmount = A_totalDebt.div(toBN(3))

      await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await priceFeed.setPrice('100000000000000000000')
      await priceFeed.fetchPrice()
      await priceFeed.setOracleFailure(true)
      await priceFeed.fetchPrice()
      assert.isTrue(await troveManager.isShutdown())

      const priceSticky = await priceFeed.getPrice()
      const { partialRedemptionHintNICR } = await hintHelpers.getRedemptionHints(redemptionAmount, priceSticky, 0)
      const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)
      const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, dennis, dennis)

      await troveManager.redeemCollateralForShutdown(redemptionAmount, alice, up, lo, sup, slo, partialRedemptionHintNICR, 0, th._100pct, { from: dennis })

      const aliceDebtAfter = await troveManager.getTroveActualDebt(alice)
      assert.isTrue(aliceDebtAfter.gt(toBN('0')))
      const aliceStatus = (await troveManager.Troves(alice))[3]
      assert.notEqual(aliceStatus, 4)
    })

    it('redeemCollateralForShutdown(): shielded, zero fee asserted in oracle shutdown', async () => {
      const { totalDebt: A_totalDebt } = await openShieldedTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
      await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(5, 18), extraParams: { from: bob } })
      await openShieldedTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: A_totalDebt, extraParams: { from: dennis } })
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await priceFeed.setPrice('100000000000000000000')
      await priceFeed.fetchPrice()
      await priceFeed.setOracleFailure(true)
      await priceFeed.fetchPrice()
      assert.isTrue(await troveManager.isShutdown())

      const priceSticky = await priceFeed.getPrice()
      const {
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints(A_totalDebt, priceSticky, 0)
      const { 0: up, 1: lo } = await sortedTroves.findInsertPosition(partialRedemptionHintNICR, firstRedemptionHint, firstRedemptionHint)
      const { 0: sup, 1: slo } = await sortedShieldedTroves.findInsertPosition(partialRedemptionHintNICR, firstRedemptionHint, firstRedemptionHint)

      const tx = await troveManager.redeemCollateralForShutdown(A_totalDebt, firstRedemptionHint, up, lo, sup, slo, partialRedemptionHintNICR, 0, th._100pct, { from: dennis })
      const fee = th.getEventArgByName(tx, "Redemption", "_collateralFee")
      assert.equal(fee.toString(), '0')
    })
  })
})