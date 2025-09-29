const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")

const TroveManagerTester = artifacts.require("TroveManagerTester")
const TroveManagerLib = artifacts.require("./Dependencies/TroveManagerLib.sol")
const LiquidationsTester = artifacts.require("LiquidationsTester")
const LUSDToken = artifacts.require("LUSDToken")
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

  let lib;
  
  const getOpenTroveTotalDebt = async (lusdAmount) => th.getOpenTroveTotalDebt(contracts, lusdAmount)
  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const getActualDebtFromComposite = async (compositeDebt) => th.getActualDebtFromComposite(compositeDebt, contracts)
  const getNetBorrowingAmount = async (debtWithFee) => th.getNetBorrowingAmount(contracts, debtWithFee)
  const openTrove = async (params) => th.openTrove(contracts, params)
  const withdrawLUSD = async (params) => th.withdrawLUSD(contracts, params)
  const driveICRToTargetWithPar = async (borrower, targetICR) => th.driveICRToTargetWithPar(contracts, borrower, targetICR)
  const calculateParTarget = async (price, coll, debt, targetICR) => th.calculateParTarget(price, coll, debt, targetICR)

  before(async () => {
    lib = await TroveManagerLib.new();
    await TroveManagerTester.link(lib);
  });
  
  async function setup(){
    contracts = await deploymentHelper.deployLiquityCore()
    contracts.liquidations = await LiquidationsTester.new()
    contracts.troveManager = await TroveManagerTester.new()
    contracts.rateControl = await RateControlTester.new()
    contracts.lusdToken = await LUSDToken.new(
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
    lqtyToken = contracts.lqtyToken
    sortedShieldedTroves = contracts.sortedShieldedTroves

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

  // Adjust each borrower’s debt pre-shutdown to reach icrOpenTarget at pOpen
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
      if (maxRepay.lte(toBN('0'))) return; // can’t repay further without violating min
      if (delta.gt(maxRepay)) delta = maxRepay;
    
      if (delta.gt(toBN('0'))) {
        const { upperHint, lowerHint } = await th.getBorrowerOpsListHint(contracts, coll, debt.sub(delta), /*shielded=*/false);
        await borrowerOperations.repayLUSD(delta, upperHint, lowerHint, { from: addr });
      }
    }
  }

  async function tcrShutdown() {
    const scrPrice = await calcSCRPrice()
    // 1.999% below scr price
    await priceFeed.setPrice(scrPrice)
    await borrowerOperations.shutdown()
    assert.isTrue(await troveManager.isShutdown())
    return scrPrice
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
        leaving Alice’s ether and LUSD debt in the ActivePool. */
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
        leaving Alice’s ether and LUSD debt in the ActivePool. */
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
        leaving Alice’s ether and LUSD debt in the ActivePool. */
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
        leaving Alice’s ether and LUSD debt in the ActivePool. */
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
        console.log('aliceSurplus', aliceSurplus.toString());
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


    describe("TroveManager - Shutdown - RedeemCollateral", () => {
      beforeEach(async () => {
      await setup()
      })
  
  it('redeemCollateralForShutdown(): A,B,C,D troves with different ICRS, redeems collateral from lowest to highest icr troves, leaving lowest troves with 0 coll and pos debt and closing the final trove', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const redemptionAmount = C_netDebt.add(B_netDebt).add(A_totalDebt)//.add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })
    // dennis withdraws collateral to bring his icr to just above MCR
    const alice_tuned_coll = await tuneCollToMCR(alice)
    const bob_tuned_coll = await tuneCollToMCR(bob)
    const carol_tuned_coll = await tuneCollToMCR(carol)
  
    const dennis_CollateralBalance_before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_before = await lusdToken.balanceOf(dennis)

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
    } = await hintHelpers.getRedemptionHints(redemptionAmount, priceAfterShutdown, 0)

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

    // Dennis redeems 20 LUSD
    // Don't pay for gas, as it makes it easier to calculate the received Ether
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

    const aliceCollAfter = await collateralToken.balanceOf(alice)
    // assert the redemption amount is equal to the total redeemed
    assert.isTrue(redemptionAmount.eq(totalRedeemed))
    // assert the collateral delta is equal to the expected collateral delta
    const expectedDelta = redemptionAmount.mul(shutdownPar.mul(mv._1e18BN)).div(mv._1e18BN).div(priceAfterRedemption)
    // TODO: high tolerance
    assert.isAtMost(th.getDifference(aliceCollAfter.sub(aliceCollBefore), expectedDelta), 600000000000000
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
    assert.isTrue(alice_totalRedeemed.eq(alice_bal))
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
    assert.isAtMost(th.getDifference(carol_expectedDelta.sub(toBN("432962787577120139644")), carol_delta), 3)
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
  it('redeemCollateralForShutdown(): A,B,C,D troves with the same ICRs, redeems collateral from first to last troves, all troves are closed', async () => {
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

    const dennis_coll_balance_before = await collateralToken.balanceOf(dennis)  
    const dennis_bal_before_dennisRedeem = await lusdToken.balanceOf(dennis)

    // dennis redeems his balance
    const dennis_redemptionTx = await troveManager.redeemCollateralForShutdown(
      dennis_bal_before_dennisRedeem,
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

  it('redeemCollateralForShutdown(): with invalid first hint, zero address', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_CollateralBalance_before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_before = await lusdToken.balanceOf(dennis)

    const price = await priceFeed.getPrice()
    assert.equal(price, dec(200, 18))

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

    /* check that Dennis' redeemed 20 LUSD has been cancelled with debt from Bobs's Trove (8) and Carol's Trove (10).
    The remaining lot (2) is sent to Alice's Trove, who had the best ICR.
    It leaves her with (3) LUSD debt + 50 for gas compensation. */
    th.assertIsApproximatelyEqual(alice_debt_After, A_totalDebt.sub(partialRedemptionAmount))
    assert.equal(bob_debt_After, '0')
    assert.equal(carol_debt_After, '0')

    const dennis_CollateralBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedCollateral = dennis_CollateralBalance_After.sub(dennis_CollateralBalance_before)
    const par = await relayer.par()
    const expectedTotalCollateralDrawn = redemptionAmount.mul(par).div(price) // convert redemptionAmount * par / collateral price, at Collateral:USD price 200
    const expectedReceivedCollateral = expectedTotalCollateralDrawn.sub(toBN(CollateralFee))// gas is not removed from erc20 collateral // .sub(toBN(th.gasUsed(redemptionTx) * GAS_PRICE)) // substract gas used for troveManager.redeemCollateral from expected received Collateral

    th.assertIsApproximatelyEqual(expectedReceivedCollateral, receivedCollateral)

    const dennis_LUSDBalance_After = (await lusdToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_before.sub(redemptionAmount))
  })

  it('redeemCollateralForShutdown(): with invalid first hint, non-existent trove', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_CollateralBalance_before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_before = await lusdToken.balanceOf(dennis)

    const price = await priceFeed.getPrice()
    assert.equal(price, dec(200, 18))

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

    /* check that Dennis' redeemed 20 LUSD has been cancelled with debt from Bobs's Trove (8) and Carol's Trove (10).
    The remaining lot (2) is sent to Alice's Trove, who had the best ICR.
    It leaves her with (3) LUSD debt + 50 for gas compensation. */
    th.assertIsApproximatelyEqual(alice_debt_After, A_totalDebt.sub(partialRedemptionAmount))
    assert.equal(bob_debt_After, '0')
    assert.equal(carol_debt_After, '0')

    const dennis_CollateralBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedCollateral = dennis_CollateralBalance_After.sub(dennis_CollateralBalance_before)
    // get par after redemption
    const par = await relayer.par()
    const expectedTotalCollateralDrawn = redemptionAmount.mul(par).div(price) // convert redemptionAmount * par / collateral price, at Collateral:USD price 200
    const expectedReceivedCollateral = expectedTotalCollateralDrawn.sub(toBN(CollateralFee))// gas is not removed from erc20 collateral // .sub(toBN(th.gasUsed(redemptionTx) * GAS_PRICE)) // substract gas used for troveManager.redeemCollateral from expected received Collateral

    th.assertIsApproximatelyEqual(expectedReceivedCollateral, receivedCollateral)

    const dennis_LUSDBalance_After = (await lusdToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_before.sub(redemptionAmount))
  })

  it('redeemCollateralForShutdown(): with invalid first hint, trove below MCR', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(310, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(250, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })
    const partialRedemptionAmount = toBN(2)
    const redemptionAmount = C_netDebt.add(B_netDebt).add(partialRedemptionAmount)
    // start Dennis with a high ICR
    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_CollateralBalance_before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_before = await lusdToken.balanceOf(dennis)

    const price = await priceFeed.getPrice()
    assert.equal(price, dec(200, 18))

    // Increase price to start Erin, and decrease it again so its ICR is under MCR
    await priceFeed.setPrice(price.mul(toBN(2)))
    await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: erin } })
    await priceFeed.setPrice(price)


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

    /* check that Dennis' redeemed 20 LUSD has been cancelled with debt from Bobs's Trove (8) and Carol's Trove (10).
    The remaining lot (2) is sent to Alice's Trove, who had the best ICR.
    It leaves her with (3) LUSD debt + 50 for gas compensation. */
    th.assertIsApproximatelyEqual(alice_debt_After, A_totalDebt.sub(partialRedemptionAmount))
    assert.equal(bob_debt_After, '0')
    assert.equal(carol_debt_After, '0')

    const dennis_CollateralBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedCollateral = dennis_CollateralBalance_After.sub(dennis_CollateralBalance_before)
    // get par after redemption
    const par = await relayer.par()
    
    const expectedTotalCollateralDrawn = redemptionAmount.mul(par).div(price) // convert redemptionAmount * par / collateral price, at Collateral:USD price 200
    const expectedReceivedCollateral = expectedTotalCollateralDrawn.sub(toBN(CollateralFee))// gas is not removed from erc20 collateral // .sub(toBN(th.gasUsed(redemptionTx) * GAS_PRICE)) // substract gas used for troveManager.redeemCollateral from expected received Collateral

    th.assertIsApproximatelyEqual(expectedReceivedCollateral, receivedCollateral)

    const dennis_LUSDBalance_After = (await lusdToken.balanceOf(dennis)).toString()
    assert.equal(dennis_LUSDBalance_After, dennis_LUSDBalance_before.sub(redemptionAmount))
  })

  it('redeemCollateralForShutdown(): ends the redemption sequence when the token redemption request has been filled', async () => {
    // --- SETUP --- 
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // Alice, Bob, Carol, Dennis, Erin open troves
    const { netDebt: A_debt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: alice } })
    const { netDebt: B_debt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: bob } })
    const { netDebt: C_debt } = await openTrove({ ICR: toBN(dec(290, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })
    const redemptionAmount = A_debt.add(B_debt).add(C_debt)
    const { totalDebt: D_totalDebt, collateral: D_coll } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: dennis } })
    const { totalDebt: E_totalDebt, collateral: E_coll } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: erin } })

    // --- TEST --- 

    // open trove from redeemer.  Redeemer has highest ICR (100Collateral, 100 LUSD), 20000%
    const { lusdAmount: F_lusdAmount } = await openTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: redemptionAmount.mul(toBN(2)), extraParams: { from: flyn } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Flyn redeems collateral
    await troveManager.redeemCollateralForShutdown(redemptionAmount, alice, alice, alice, alice, alice, 0, 0, th._100pct, { from: flyn })

    // Check Flyn's redemption has reduced his balance from 100 to (100-60) = 40 LUSD
    const flynBalance = await lusdToken.balanceOf(flyn)
    th.assertIsApproximatelyEqual(flynBalance, F_lusdAmount.sub(redemptionAmount))

    // Check debt of Alice, Bob, Carol
    const alice_Debt = await troveManager.getTroveDebt(alice)
    const bob_Debt = await troveManager.getTroveDebt(bob)
    const carol_Debt = await troveManager.getTroveDebt(carol)

    assert.equal(alice_Debt, 0)
    assert.equal(bob_Debt, 0)
    assert.equal(carol_Debt, 0)

    // check Alice, Bob and Carol troves are closed by redemption
    const alice_Status = await troveManager.getTroveStatus(alice)
    const bob_Status = await troveManager.getTroveStatus(bob)
    const carol_Status = await troveManager.getTroveStatus(carol)
    assert.equal(alice_Status, 4)
    assert.equal(bob_Status, 4)
    assert.equal(carol_Status, 4)

    // check debt and coll of Dennis, Erin has not been impacted by redemption
    const dennis_Debt = await troveManager.getTroveDebt(dennis)
    const erin_Debt = await troveManager.getTroveDebt(erin)

    th.assertIsApproximatelyEqual(dennis_Debt, D_totalDebt)
    th.assertIsApproximatelyEqual(erin_Debt, E_totalDebt)

    const dennis_Coll = await troveManager.getTroveColl(dennis)
    const erin_Coll = await troveManager.getTroveColl(erin)

    assert.equal(dennis_Coll.toString(), D_coll.toString())
    assert.equal(erin_Coll.toString(), E_coll.toString())
  })

  it('redeemCollateralForShutdown(): ends the redemption sequence when max iterations have been reached', async () => {
    // --- SETUP --- 
    await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })

    // Alice, Bob, Carol open troves with equal collateral ratio
    const { netDebt: A_debt } = await openTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: alice } })
    const { netDebt: B_debt } = await openTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: bob } })
    const { netDebt: C_debt, totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(286, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })
    const redemptionAmount = A_debt.add(B_debt)
    const attemptedRedemptionAmount = redemptionAmount.add(C_debt)

    // --- TEST --- 

    // open trove from redeemer.  Redeemer has highest ICR (100Collateral, 100 LUSD), 20000%
    const { lusdAmount: F_lusdAmount } = await openTrove({ ICR: toBN(dec(200, 18)), extraLUSDAmount: redemptionAmount.mul(toBN(2)), extraParams: { from: flyn } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Flyn redeems collateral with only two iterations
    await troveManager.redeemCollateralForShutdown(attemptedRedemptionAmount, alice, alice, alice, alice, alice, 0, 2, th._100pct, { from: flyn })

    // Check Flyn's redemption has reduced his balance from 100 to (100-40) = 60 LUSD
    const flynBalance = (await lusdToken.balanceOf(flyn)).toString()
    th.assertIsApproximatelyEqual(flynBalance, F_lusdAmount.sub(redemptionAmount))

    // Check debt of Alice, Bob, Carol
    const alice_Debt = await troveManager.getTroveDebt(alice)
    const bob_Debt = await troveManager.getTroveDebt(bob)
    const carol_Debt = await troveManager.getTroveDebt(carol)

    assert.equal(alice_Debt, 0)
    assert.equal(bob_Debt, 0)
    th.assertIsApproximatelyEqual(carol_Debt, C_totalDebt)

    // check Alice and Bob troves are closed, but Carol is not
    const alice_Status = await troveManager.getTroveStatus(alice)
    const bob_Status = await troveManager.getTroveStatus(bob)
    const carol_Status = await troveManager.getTroveStatus(carol)
    assert.equal(alice_Status, 4)
    assert.equal(bob_Status, 4)
    assert.equal(carol_Status, 1)
  })

  it("redeemCollateralForShutdown(): performs partial redemption if resultant debt is > minimum net debt", async () => {
    const collateralAmount = dec(1000, 'ether')
    await collateralToken.approve(activePool.address, collateralAmount, { from: A })
    await collateralToken.approve(activePool.address, collateralAmount, { from: B })
    await collateralToken.approve(activePool.address, collateralAmount, { from: C })
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10000, 18)), A, A, false, { from: A })
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(20000, 18)), B, B, false, { from: B })
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), C, C, false, { from: C })

    // A and C send all their tokens to B
    await lusdToken.transfer(B, await lusdToken.balanceOf(A), {from: A})
    await lusdToken.transfer(B, await lusdToken.balanceOf(C), {from: C})
    
    await aggregator.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Before redemption

    // LUSD redemption is 55000 US
    const LUSDRedemption = dec(55000, 18)

    const tx1 = await th.redeemCollateralAndGetTxObject(B, contracts, LUSDRedemption, th._100pct)

    // get redemption fee from emitted event
    const redemptionFee = tx1.receipt.logs.filter(log => log.event === "Redemption")[0].args[3];
    // console.log("redemptionFee", redemptionFee.toString())

    // Check B, C closed and A remains active
    assert.isTrue(await sortedTroves.contains(A))
    assert.isFalse(await sortedTroves.contains(B))
    assert.isFalse(await sortedTroves.contains(C))
    const par = await relayer.par()
    const expectedDebt = toBN(dec(4600, 18))//.mul(par).div(toBN(dec(1, 18)))
    // A's remaining debt = 29800 + 19800 + 9800 + 200 - 55000 = 4600
    const A_debt = await troveManager.getTroveDebt(A)
    // console.log("A_debt", A_debt.toString())
    // console.log("expectedDebt", expectedDebt.toString())
    th.assertIsApproximatelyEqual(A_debt, expectedDebt, 1000)
  })

  it("redeemCollateralForShutdown(): doesn't perform partial redemption if resultant debt would be < minimum net debt", async () => {
    const collateralAmount = dec(1000, 'ether')
    await collateralToken.approve(activePool.address, collateralAmount, { from: A })
    await collateralToken.approve(activePool.address, collateralAmount, { from: B })
    await collateralToken.approve(activePool.address, collateralAmount, { from: C })  
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount(dec(6000, 18)), A, A, false, { from: A })
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount(dec(20000, 18)), B, B, false, { from: B })
    await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount(dec(30000, 18)), C, C, false, { from: C })

    // A and C send all their tokens to B
    await lusdToken.transfer(B, await lusdToken.balanceOf(A), {from: A})
    await lusdToken.transfer(B, await lusdToken.balanceOf(C), {from: C})

    await aggregator.setBaseRate(0) 

    // Skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // LUSD redemption is 55000 LUSD
    const LUSDRedemption = dec(55000, 18)
    const tx1 = await th.redeemCollateralAndGetTxObject(B, contracts, LUSDRedemption, th._100pct)
    
    // Check B, C closed and A remains active
    assert.isTrue(await sortedTroves.contains(A))
    assert.isFalse(await sortedTroves.contains(B))
    assert.isFalse(await sortedTroves.contains(C))

    // A's remaining debt would be 29950 + 19950 + 5950 + 50 - 55000 = 900.
    // Since this is below the min net debt of 100, A should be skipped and untouched by the redemption
    const A_debt = await troveManager.getTroveDebt(A)
    await th.assertIsApproximatelyEqual(A_debt, dec(6000, 18))
  })

  it('redeemCollateralForShutdown(): doesnt perform the final partial redemption in the sequence if the hint is out-of-date', async () => {
    // --- SETUP ---
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(363, 16)), extraLUSDAmount: dec(5, 18), extraParams: { from: alice } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(344, 16)), extraLUSDAmount: dec(8, 18), extraParams: { from: bob } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(333, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: carol } })

    const partialRedemptionAmount = toBN(2)
    const fullfilledRedemptionAmount = C_netDebt.add(B_netDebt)
    const redemptionAmount = fullfilledRedemptionAmount.add(partialRedemptionAmount)

    await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: redemptionAmount, extraParams: { from: dennis } })

    const dennis_CollateralBalance_before = toBN(await collateralToken.balanceOf(dennis))

    const dennis_LUSDBalance_before = await lusdToken.balanceOf(dennis)

    const price = await priceFeed.getPrice()
    assert.equal(price, dec(200, 18))

    // --- TEST --- 

    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(redemptionAmount, price, 0)

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
      } = await hintHelpers.getRedemptionHints(dec(1, 18), price, 0)

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

    // Dennis tries to redeem 20 LUSD
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

    const CollateralFee = th.getEmittedRedemptionValues(redemptionTx)[3]
    const CollateralDrawn = th.getEmittedRedemptionValues(redemptionTx)[2]
    const totalRedeemed = th.getEmittedRedemptionValues(redemptionTx)[1]

    // Since Alice already redeemed 1 LUSD from Carol's Trove, Dennis was  able to redeem:
    //  - 9 LUSD from Carol's
    //  - 8 LUSD from Bob's
    // for a total of 17 LUSD.

    // Dennis calculated his hint for redeeming 2 LUSD from Alice's Trove, but after Alice's transaction
    // got in the way, he would have needed to redeem 3 LUSD to fully complete his redemption of 20 LUSD.
    // This would have required a different hint, therefore he ended up with a partial redemption.

    const dennis_CollateralBalance_After = toBN(await collateralToken.balanceOf(dennis))
    const receivedCollateral = dennis_CollateralBalance_After.sub(dennis_CollateralBalance_before)

    // Expect only 17 worth of Collateral drawn
    const expectedTotalCollateralDrawn = fullfilledRedemptionAmount.sub(frontRunRedemption).mul(parBeforeDennisRedemption).div(price)//.div(toBN(200)) // redempted LUSD converted to Collateral, at Collateral:USD price 200
    const expectedReceivedCollateral = expectedTotalCollateralDrawn.sub(CollateralFee)

    th.assertIsApproximatelyEqual(expectedReceivedCollateral, receivedCollateral)

    const dennis_LUSDBalance_After = (await lusdToken.balanceOf(dennis)).toString()
    th.assertIsApproximatelyEqual(dennis_LUSDBalance_After, dennis_LUSDBalance_before.sub(fullfilledRedemptionAmount.sub(frontRunRedemption)))
  })

  // active debt cannot be zero, as there's a positive min debt enforced, and at least a trove must exist
  it("redeemCollateralForShutdown(): can redeem if there is zero active debt but non-zero debt in DefaultPool", async () => {
    // --- SETUP ---

    const amount = await getOpenTroveLUSDAmount(dec(210, 18))
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(133, 16)), extraLUSDAmount: amount, extraParams: { from: bob } })

    await lusdToken.transfer(carol, amount, { from: bob })

    const price = dec(100, 18)
    await priceFeed.setPrice(price)

    // Liquidate Bob's Trove
    await liquidations.liquidateTroves(1)

    // --- TEST --- 

    const carol_CollateralBalance_before = toBN(await collateralToken.balanceOf(carol))
    const nicrHint = await hintHelpers.getRedemptionHints(amount, price, 0)

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    const redemptionTx = await troveManager.redeemCollateralForShutdown(
      amount,
      alice,
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

    const CollateralFee = th.getEmittedRedemptionValues(redemptionTx)[3]
    const par = await relayer.par() // Get current par value

    const carol_CollateralBalance_After = toBN(await collateralToken.balanceOf(carol))

    // Calculate how much collateral should be redeemed for the given LUSD amount
    // CollateralAmount = (LUSDAmount * par) / price
    const expectedTotalCollateralDrawn = toBN(amount).mul(par).div(toBN(price))

    const expectedReceivedCollateral = expectedTotalCollateralDrawn.sub(CollateralFee)

    const receivedCollateral = carol_CollateralBalance_After.sub(carol_CollateralBalance_before)

    assert.isTrue(expectedReceivedCollateral.eq(receivedCollateral))

    const carol_LUSDBalance_After = (await lusdToken.balanceOf(carol)).toString()
    assert.equal(carol_LUSDBalance_After, '0')
  })

  it("redeemCollateralForShutdown(): doesn't touch Troves with ICR < 110%", async () => {
    // --- SETUP ---

    const { netDebt: A_debt } = await openTrove({ ICR: toBN(dec(13, 18)), extraParams: { from: alice } })
    const { lusdAmount: B_lusdAmount, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(133, 16)), extraLUSDAmount: A_debt, extraParams: { from: bob } })

    await lusdToken.transfer(carol, B_lusdAmount, { from: bob })

    // Put Bob's Trove below 110% ICR
    const price = dec(100, 18)
    await priceFeed.setPrice(price)

    // --- TEST --- 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await troveManager.redeemCollateralForShutdown(
      A_debt,
      alice,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      0,
      0,
      th._100pct,
      { from: carol }
    );

    // Alice's Trove was cleared of debt
    const { debt: alice_debt_After } = await troveManager.Troves(alice)
    assert.equal(alice_debt_After, '0')

    // Bob's Trove was left untouched
    const { debt: bob_debt_After } = await troveManager.Troves(bob)
    th.assertIsApproximatelyEqual(bob_debt_After, B_totalDebt)
  });

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
    
    const { debt: alice_debt_After } = await troveManager.Troves(alice)
    assert.equal(alice_debt_After, '0')

    const { debt: bob_debt_After } = await troveManager.Troves(bob)
    assert.equal(bob_debt_After, '0')

    const { debt: carol_debt_After } = await troveManager.Troves(carol)
    assert.equal(carol_debt_After, '0')

    const { debt: dennis_debt_After } = await troveManager.Troves(dennis)
    th.assertIsApproximatelyEqual(dennis_debt_After, D_totalDebt)
  });

  it("redeemCollateralForShutdown(): reverts when TCR < MCR", async () => {
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: bob } })
    await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
    await openTrove({ ICR: toBN(dec(196, 16)), extraParams: { from: dennis } })

    // This will put Dennis slightly below 110%, and everyone else exactly at 110%
  
    await priceFeed.setPrice('110' + _18_zeros)
    const price = await priceFeed.getPrice()
    
    const TCR = (await th.getTCR(contracts))
    assert.isTrue(TCR.lt(toBN('1100000000000000000')))

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await assertRevert(th.redeemCollateralForShutdown(carol, contracts, GAS_PRICE, dec(270, 18)), "TroveManager: Cannot redeem when TCR < MCR")
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

  it("redeemCollateralForShutdown(): reverts if max fee > 100%", async () => {
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(10, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(20, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(30, 18), extraParams: { from: C } })
    await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(40, 18), extraParams: { from: D } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE ,dec(2, 18)), "maxFee% out of [0.5,100]")
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE, '1000000000000000001'), "maxFee% out of [0.5,100]")
  })

  it("redeemCollateralForShutdown(): reverts if max fee < 0.5%", async () => { 
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
  it("redeemCollateralForShutdown(): reverts if fee exceeds max fee percentage", async () => {
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(80, 18), extraParams: { from: A } })
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(90, 18), extraParams: { from: B } })
    const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const expectedTotalSupply = A_totalDebt.add(B_totalDebt).add(C_totalDebt)

    // Check total LUSD supply
    const totalSupply = await lusdToken.totalSupply()
    th.assertIsApproximatelyEqual(totalSupply, expectedTotalSupply)

    await aggregator.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // LUSD redemption is 27 USD: a redemption that incurs a fee of 27/(270 * 2) = 5%
    const attemptedLUSDRedemption = expectedTotalSupply.div(toBN(10))

    // Max fee is <5%
    const lessThan5pct = '49999999999999999'
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, lessThan5pct), "Fee exceeded provided maximum")
  
    await aggregator.setBaseRate(0)  // artificially zero the baseRate
    
    // Max fee is 1%
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, dec(1, 16)), "Fee exceeded provided maximum")
  
    await aggregator.setBaseRate(0)

     // Max fee is 3.754%
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, dec(3754, 13)), "Fee exceeded provided maximum")
  
    await aggregator.setBaseRate(0)

    // Max fee is 0.5%
    await assertRevert(th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, dec(5, 15)), "Fee exceeded provided maximum")
  })

  it("redeemCollateralForShutdown(): succeeds if fee is less than max fee percentage", async () => {
    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(9500, 18), extraParams: { from: A } })
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(395, 16)), extraLUSDAmount: dec(9000, 18), extraParams: { from: B } })
    const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(390, 16)), extraLUSDAmount: dec(10000, 18), extraParams: { from: C } })
    const expectedTotalSupply = A_totalDebt.add(B_totalDebt).add(C_totalDebt)

    // Check total LUSD supply
    const totalSupply = await lusdToken.totalSupply()
    th.assertIsApproximatelyEqual(totalSupply, expectedTotalSupply)

    await aggregator.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // LUSD redemption fee with 10% of the supply will be 0.5% + 1/(10*2)
    const attemptedLUSDRedemption = expectedTotalSupply.div(toBN(10))

    // Attempt with maxFee > 5.5%
    const price = await priceFeed.getPrice()
    const collateralDrawn = attemptedLUSDRedemption.mul(mv._1e18BN).div(price)
    const slightlyMoreThanFee = (await aggregator.getRedemptionFeeWithDecay(collateralDrawn))
    const tx1 = await th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, slightlyMoreThanFee)
    assert.isTrue(tx1.receipt.status)

    await aggregator.setBaseRate(0)  // Artificially zero the baseRate
    
    // Attempt with maxFee = 5.5%
    const exactSameFee = (await aggregator.getRedemptionFeeWithDecay(collateralDrawn))
    const tx2 = await th.redeemCollateralAndGetTxObject(C, contracts, attemptedLUSDRedemption, exactSameFee)
    assert.isTrue(tx2.receipt.status)

    await aggregator.setBaseRate(0)

     // Max fee is 10%
    const tx3 = await th.redeemCollateralAndGetTxObject(B, contracts, attemptedLUSDRedemption, dec(1, 17))
    assert.isTrue(tx3.receipt.status)

    await aggregator.setBaseRate(0)

    // Max fee is 37.659%
    const tx4 = await th.redeemCollateralAndGetTxObject(A, contracts, attemptedLUSDRedemption, dec(37659, 13))
    assert.isTrue(tx4.receipt.status)

    await aggregator.setBaseRate(0)

    // Max fee is 100%
    const tx5 = await th.redeemCollateralAndGetTxObject(C, contracts, attemptedLUSDRedemption, dec(1, 18))
    assert.isTrue(tx5.receipt.status)
  })

  it("redeemCollateralForShutdown(): doesn't affect the Stability Pool deposits or Collateral gain of redeemed-from troves", async () => {
    //contracts.rateControl.setCoBias(0)
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // B, C, D, F open trove
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: bob } })
    const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(195, 16)), extraLUSDAmount: dec(200, 18), extraParams: { from: carol } })
    const { totalDebt: D_totalDebt } = await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(400, 18), extraParams: { from: dennis } })
    const { totalDebt: F_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: flyn } })

    const redemptionAmount = B_totalDebt.add(C_totalDebt).add(D_totalDebt).add(F_totalDebt)
    // Alice opens trove and transfers LUSD to Erin, the would-be redeemer
    await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: redemptionAmount, extraParams: { from: alice } })
    await lusdToken.transfer(erin, redemptionAmount, { from: alice })

    // B, C, D deposit some of their tokens to the Stability Pool
    await stabilityPool.provideToSP(dec(50, 18), ZERO_ADDRESS, { from: bob })
    await stabilityPool.provideToSP(dec(150, 18), ZERO_ADDRESS, { from: carol })
    await stabilityPool.provideToSP(dec(200, 18), ZERO_ADDRESS, { from: dennis })

    let price = await priceFeed.getPrice()
    const bob_ICR_before = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_before = await troveManager.getCurrentICR(carol, price)
    const dennis_ICR_before = await troveManager.getCurrentICR(dennis, price)

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    assert.isTrue(await sortedTroves.contains(flyn))

    // Liquidate Flyn
    await liquidations.liquidate(flyn)
    assert.isFalse(await sortedTroves.contains(flyn))

    // Price bounces back, bringing B, C, D back above MCR
    await priceFeed.setPrice(dec(200, 18))

    const bob_SPDeposit_before = await stabilityPool.getCompoundedLUSDDeposit(bob)
    const carol_SPDeposit_before = await stabilityPool.getCompoundedLUSDDeposit(carol)
    const dennis_SPDeposit_before = await stabilityPool.getCompoundedLUSDDeposit(dennis)

    const bob_CollateralGain_before = await stabilityPool.getDepositorCollateralGain(bob)
    const carol_CollateralGain_before = await stabilityPool.getDepositorCollateralGain(carol)
    const dennis_CollateralGain_before = await stabilityPool.getDepositorCollateralGain(dennis)

    // Check the remaining LUSD and Collateral in Stability Pool after liquidation is non-zero
    const LUSDinSP = await stabilityPool.getTotalLUSDDeposits()
    const CollateralinSP = await stabilityPool.getCollateral()
    assert.isTrue(LUSDinSP.gte(mv._zeroBN))
    assert.isTrue(CollateralinSP.gte(mv._zeroBN))

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Erin redeems LUSD
    tx = await th.redeemCollateralAndGetTxObject(erin, contracts, redemptionAmount, th._100pct)

    price = await priceFeed.getPrice()
    const bob_ICR_after = await troveManager.getCurrentICR(bob, price)
    const carol_ICR_after = await troveManager.getCurrentICR(carol, price)
    const dennis_ICR_after = await troveManager.getCurrentICR(dennis, price)

    // Check ICR of B, C and D troves has increased,i.e. they have been hit by redemptions
    assert.isTrue(bob_ICR_after.gte(bob_ICR_before))
    assert.isTrue(carol_ICR_after.gte(carol_ICR_before))
    assert.isTrue(dennis_ICR_after.gte(dennis_ICR_before))

    const bob_SPDeposit_after = await stabilityPool.getCompoundedLUSDDeposit(bob)
    const carol_SPDeposit_after = await stabilityPool.getCompoundedLUSDDeposit(carol)
    const dennis_SPDeposit_after = await stabilityPool.getCompoundedLUSDDeposit(dennis)

    const bob_CollateralGain_after = await stabilityPool.getDepositorCollateralGain(bob)
    const carol_CollateralGain_after = await stabilityPool.getDepositorCollateralGain(carol)
    const dennis_CollateralGain_after = await stabilityPool.getDepositorCollateralGain(dennis)

    // Check B, C, D Stability Pool deposits and Collateral gain have not been affected by redemptions from their troves
    // redeemCollatera() drips so deposits will increase
    assert.isTrue(bob_SPDeposit_after.gt(bob_SPDeposit_before))
    th.assertIsApproximatelyEqual(bob_SPDeposit_before, bob_SPDeposit_after, 140000000000000000)
    assert.isTrue(carol_SPDeposit_after.gt(carol_SPDeposit_before))
    th.assertIsApproximatelyEqual(carol_SPDeposit_before, carol_SPDeposit_after, 1700000000000000000)
    assert.isTrue(dennis_SPDeposit_after.gt(dennis_SPDeposit_before))
    th.assertIsApproximatelyEqual(dennis_SPDeposit_before, dennis_SPDeposit_after, 530000000000000000)


    assert.isTrue(bob_CollateralGain_before.eq(bob_CollateralGain_after))
    assert.isTrue(carol_CollateralGain_before.eq(carol_CollateralGain_after))
    assert.isTrue(dennis_CollateralGain_before.eq(dennis_CollateralGain_after))
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

    const price = await priceFeed.getPrice()

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    amount = dec(400, 18)
    // Erin attempts to redeem 400 LUSD
    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(amount, price, 0)

    const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      erin,
      erin
    )
    const { 0: upperShieldedPartialRedemptionHint, 1: lowerShieldedPartialRedemptionHint } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      erin,
      erin
    )

    // console.log(`activePool_coll_before: ${activePool_coll_before}`)

    tx = await troveManager.redeemCollateralForShutdown(
      amount,
      firstRedemptionHint,
      upperPartialRedemptionHint,
      lowerPartialRedemptionHint,
      upperShieldedPartialRedemptionHint,
      lowerShieldedPartialRedemptionHint,
      partialRedemptionHintNICR,
      0, th._100pct,
      { from: erin })

    /*
    const totalRedeemed = th.getEmittedRedemptionValues(tx)[1]
    const totalCollateralDrawn = th.getEmittedRedemptionValues(tx)[2]
    const totalCollateralFee = th.getEmittedRedemptionValues(tx)[3]
    console.log("totalRedeemed", totalRedeemed.toString())
    console.log("totalCollateralDrawn", totalCollateralDrawn.toString())
    console.log("totalCollateralFee", totalCollateralFee.toString())
    */
    // get fee from tx
    const fee = tx.receipt.logs.filter(log => log.event === "Redemption")[0].args[3]

    // Check activePool debt reduced by  400 LUSD
    const activePool_debt_after = await activePool.getLUSDDebt()
    assert.equal(activePool_debt_before.sub(activePool_debt_after), amount)

    /* Check ActivePool coll reduced by $400 worth of Ether: at Collateral:USD price of $200, this should be 2 Collateral.

    therefore remaining ActivePool Collateral should be 198 */
    const activePool_coll_after = await activePool.getCollateral()
    // console.log(`activePool_coll_after: ${activePool_coll_after}`)
    // console.log(`Exp:  ${activePool_coll_before.sub(toBN(dec(2, 18)))}`)
    // subtract fee from activePool_coll_after since redemption fee stats in the trove
    assert.equal(activePool_coll_after.sub(fee).toString(), activePool_coll_before.sub(toBN(dec(2, 18))).toString())

    // Check Erin's balance after
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

  it("redeemCollateralForShutdown(): value of issued Collateral == face value of redeemed LUSD (assuming 1 LUSD has value of $1)", async () => {
    const { collateral: W_coll } = await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    // Alice opens trove and transfers 1000 LUSD each to Erin, Flyn, Graham
    const { collateral: A_coll, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(400, 16)), extraLUSDAmount: dec(4990, 18), extraParams: { from: alice } })
    await lusdToken.transfer(erin, dec(1000, 18), { from: alice })
    await lusdToken.transfer(flyn, dec(1000, 18), { from: alice })
    await lusdToken.transfer(graham, dec(1000, 18), { from: alice })

    // B, C, D open trove
    const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(300, 16)), extraLUSDAmount: dec(1590, 18), extraParams: { from: bob } })
    const { collateral: C_coll } = await openTrove({ ICR: toBN(dec(600, 16)), extraLUSDAmount: dec(1090, 18), extraParams: { from: carol } })
    const { collateral: D_coll } = await openTrove({ ICR: toBN(dec(800, 16)), extraLUSDAmount: dec(1090, 18), extraParams: { from: dennis } })

    const totalColl = W_coll.add(A_coll).add(B_coll).add(C_coll).add(D_coll)

    const price = await priceFeed.getPrice()

    const _120_LUSD = '120000000000000000000'
    const _373_LUSD = '373000000000000000000'
    const _950_LUSD = '950000000000000000000'

    // Check Ether in activePool
    const activeCollateral_0 = await activePool.getCollateral()
    assert.equal(activeCollateral_0, totalColl.toString());

    let firstRedemptionHint
    let partialRedemptionHintNICR


    // Erin redeems 120 LUSD
    ({
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(_120_LUSD, price, 0))

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

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    const redemption_1 = await troveManager.redeemCollateralForShutdown(
      _120_LUSD,
      firstRedemptionHint,
      upperPartialRedemptionHint_1,
      lowerPartialRedemptionHint_1,
      upperShieldedPartialRedemptionHint_1,
      lowerShieldedPartialRedemptionHint_1,
      partialRedemptionHintNICR,
      0, th._100pct,
      { from: erin })

    assert.isTrue(redemption_1.receipt.status);

    /* 120 LUSD redeemed.  Expect $120 worth of Collateral removed. At Collateral:USD price of $200, 
    Collateral removed = (120/200) = 0.6 Collateral
    Total active Collateral = 280 - 0.6 = 279.4 Collateral */
    // get fee from tx
    const fee = redemption_1.receipt.logs.filter(log => log.event === "Redemption")[0].args[3];
    const activeCollateral_1 = await activePool.getCollateral()
    assert.equal(activeCollateral_1.sub(fee).toString(), activeCollateral_0.sub(toBN(_120_LUSD).mul(mv._1e18BN).div(price)).toString());

    // Flyn redeems 373 LUSD
    ({
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(_373_LUSD, price, 0))

    const { 0: upperPartialRedemptionHint_2, 1: lowerPartialRedemptionHint_2 } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      flyn,
      flyn
    )
    const { 0: upperShieldedPartialRedemptionHint_2, 1: lowerShieldedPartialRedemptionHint_2 } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      flyn,
      flyn
    )

    const redemption_2 = await troveManager.redeemCollateralForShutdown(
      _373_LUSD,
      firstRedemptionHint,
      upperPartialRedemptionHint_2,
      lowerPartialRedemptionHint_2,
      upperShieldedPartialRedemptionHint_2,
      lowerShieldedPartialRedemptionHint_2,
      partialRedemptionHintNICR,
      0, th._100pct,
      { from: flyn })

    assert.isTrue(redemption_2.receipt.status);

    /* 373 LUSD redeemed.  Expect $373 worth of Collateral removed. At Collateral:USD price of $200, 
    Collateral removed = (373/200) = 1.865 Collateral
    Total active Collateral = 279.4 - 1.865 = 277.535 Collateral */
    const activeCollateral_2 = await activePool.getCollateral()
    // get fee from tx
    const fee2 = redemption_2.receipt.logs.filter(log => log.event === "Redemption")[0].args[3];
    assert.equal(activeCollateral_2.sub(fee2).toString(), activeCollateral_1.sub(toBN(_373_LUSD).mul(mv._1e18BN).div(price)).toString());

    // Graham redeems 950 LUSD
    ({
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(_950_LUSD, price, 0))

    const { 0: upperPartialRedemptionHint_3, 1: lowerPartialRedemptionHint_3 } = await sortedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      graham,
      graham
    )
    const { 0: upperShieldedPartialRedemptionHint_3, 1: lowerShieldedPartialRedemptionHint_3 } = await sortedShieldedTroves.findInsertPosition(
      partialRedemptionHintNICR,
      graham,
      graham
    )

    const redemption_3 = await troveManager.redeemCollateralForShutdown(
      _950_LUSD,
      firstRedemptionHint,
      upperPartialRedemptionHint_3,
      lowerPartialRedemptionHint_3,
      upperShieldedPartialRedemptionHint_3,
      lowerShieldedPartialRedemptionHint_3,
      partialRedemptionHintNICR,
      0, th._100pct,
      { from: graham })

    assert.isTrue(redemption_3.receipt.status);
    // get fee from tx
    const fee3 = redemption_3.receipt.logs.filter(log => log.event === "Redemption")[0].args[3];

    /* 950 LUSD redeemed.  Expect $950 worth of Collateral removed. At Collateral:USD price of $200, 
    Collateral removed = (950/200) = 4.75 Collateral
    Total active Collateral = 277.535 - 4.75 = 272.785 Collateral */
    const activeCollateral_3 = await activePool.getCollateral()
    assert.equal(activeCollateral_3.sub(fee3).toString(), activeCollateral_2.sub(toBN(_950_LUSD).mul(mv._1e18BN).div(price)).toString());
  })

  // it doesn't make much sense as there's now min debt enforced and at least one trove must remain active
  // the only way to test it is before any trove is opened
  it("redeemCollateralForShutdown(): reverts if there is zero outstanding system debt", async () => {
    // --- SETUP --- illegally mint LUSD to Bob
    await lusdToken.unprotectedMint(bob, dec(100, 18))

    assert.equal((await lusdToken.balanceOf(bob)), dec(100, 18))

    const price = await priceFeed.getPrice()

    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(dec(100, 18), price, 0)

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

    // Bob tries to redeem his illegally obtained LUSD
    try {
      const redemptionTx = await troveManager.redeemCollateralForShutdown(
        dec(100, 18),
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

    //assert.isFalse(redemptionTx.receipt.status);
    debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
    supply = await contracts.lusdToken.totalSupply()
    // console.log("debt", debt.toString())
    // console.log("supply", supply.toString())
    // console.log("supply - debt", supply.sub(debt).toString())
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

    await th.redeemCollateralForShutdown(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    assert.isTrue((await aggregator.baseRate()).gt(toBN('0')))
  })

  it("redeemCollateralForShutdown(): a redemption made when base rate is non-zero increases the base rate, for negligible time passed", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // Check baseRate == 0
    assert.equal(await aggregator.baseRate(), '0')

    const A_balanceBefore = await lusdToken.balanceOf(A)
    const B_balanceBefore = await lusdToken.balanceOf(B)

    // A redeems 10 LUSD
    const redemptionTx_A = await th.redeemCollateralAndGetTxObject(A, contracts, dec(10, 18), GAS_PRICE)
    const timeStamp_A = await th.getTimestampFromTx(redemptionTx_A, web3)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await aggregator.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    // B redeems 10 LUSD
    const redemptionTx_B = await th.redeemCollateralAndGetTxObject(B, contracts, dec(10, 18), GAS_PRICE)
    const timeStamp_B = await th.getTimestampFromTx(redemptionTx_B, web3)

    // Check B's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check negligible time difference (< 1 minute) between txs
    assert.isTrue(Number(timeStamp_B) - Number(timeStamp_A) < 60)

    const baseRate_2 = await aggregator.baseRate()

    // Check baseRate has again increased
    assert.isTrue(baseRate_2.gt(baseRate_1))
  })

  it("redeemCollateralForShutdown(): lastFeeOpTime doesn't update if less time than decay interval has passed since the last fee operation [ @skip-on-coverage ]", async () => {
    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    const A_balanceBefore = await lusdToken.balanceOf(A)

    // A redeems 10 LUSD
    await th.redeemCollateralForShutdown(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(A_balanceBefore.sub(await lusdToken.balanceOf(A)), dec(10, 18))

    // Check baseRate is now non-zero
    const baseRate_1 = await aggregator.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    const lastFeeOpTime_1 = await aggregator.lastFeeOperationTime()

    // 45 seconds pass
    th.fastForwardTime(45, web3.currentProvider)

    // Borrower A triggers a fee
    await th.redeemCollateralForShutdown(A, contracts, dec(1, 18), GAS_PRICE)

    const lastFeeOpTime_2 = await aggregator.lastFeeOperationTime()

    // Check that the last fee operation time did not update, as borrower A's 2nd redemption occured
    // since before minimum interval had passed 
    assert.isTrue(lastFeeOpTime_2.eq(lastFeeOpTime_1))

    // 15 seconds passes
    th.fastForwardTime(15, web3.currentProvider)

    // Check that now, at least one hour has passed since lastFeeOpTime_1
    const timeNow = await th.getLatestBlockTimestamp(web3)
    assert.isTrue(toBN(timeNow).sub(lastFeeOpTime_1).gte(3600))

    // Borrower A triggers a fee
    await th.redeemCollateralForShutdown(A, contracts, dec(1, 18), GAS_PRICE)

    const lastFeeOpTime_3 = await aggregator.lastFeeOperationTime()

    // Check that the last fee operation time DID update, as A's 2rd redemption occured
    // after minimum interval had passed 
    assert.isTrue(lastFeeOpTime_3.gt(lastFeeOpTime_1))
  })
  // collateral fees now stay in the trove, so this test is not relevant
  it.skip("redeemCollateralForShutdown(): a redemption made at zero base rate send a non-zero CollateralFee to LQTY staking contract", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // Check baseRate == 0
    assert.equal(await aggregator.baseRate(), '0')

    // Check LQTY Staking contract balance before is zero
    const lqtyStakingBalance_before = await collateralToken.balanceOf(lqtyStaking.address)
    assert.equal(lqtyStakingBalance_before, '0')

    const A_balanceBefore = await lusdToken.balanceOf(A)

    // A redeems 10 LUSD
    await th.redeemCollateralForShutdown(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await aggregator.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    // Check LQTY Staking contract balance after is non-zero
    const lqtyStakingBalance_After = toBN(await collateralToken.balanceOf(lqtyStaking.address))
    console.log("lqtyStakingBalance_After", lqtyStakingBalance_After.toString())
    assert.isTrue(lqtyStakingBalance_After.gt(toBN('0')))
  })

  it("redeemCollateralForShutdown(): a redemption made at zero base increases the Collateral-fees-per-LQTY-staked in LQTY Staking contract", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // Check baseRate == 0
    assert.equal(await aggregator.baseRate(), '0')

    // Check LQTY Staking Collateral-fees-per-LQTY-staked before is zero
    const F_Coll_before = await lqtyStaking.F_Collateral()
    assert.equal(F_Coll_before, '0')

    const A_balanceBefore = await lusdToken.balanceOf(A)

    // A redeems 10 LUSD
    await th.redeemCollateralForShutdown(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await aggregator.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    // Check LQTY Staking Collateral-fees-per-LQTY-staked after is non-zero
    const F_Collateral_After = await lqtyStaking.F_Collateral()
    assert.isTrue(F_Collateral_After.gt('0'))
  })

  // collateral fees now stay in the trove, so this test is not relevant
  it.skip("redeemCollateralForShutdown(): a redemption made at a non-zero base rate send a non-zero CollateralFee to LQTY staking contract", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // Check baseRate == 0
    assert.equal(await aggregator.baseRate(), '0')

    const A_balanceBefore = await lusdToken.balanceOf(A)
    const B_balanceBefore = await lusdToken.balanceOf(B)

    // A redeems 10 LUSD
    await th.redeemCollateralForShutdown(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await aggregator.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    const lqtyStakingBalance_before = toBN(await collateralToken.balanceOf(lqtyStaking.address))

    // B redeems 10 LUSD
    await th.redeemCollateralForShutdown(B, contracts, dec(10, 18), GAS_PRICE)

    // Check B's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

    const lqtyStakingBalance_After = toBN(await collateralToken.balanceOf(lqtyStaking.address))

    // check LQTY Staking balance has increased
    assert.isTrue(lqtyStakingBalance_After.gt(lqtyStakingBalance_before))
  })

  // collateral fees now stay in the trove, so this test is not relevant
  it.skip("redeemCollateralForShutdown(): a redemption made at a non-zero base rate increases Collateral-per-LQTY-staked in the staking contract", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    // Check baseRate == 0
    assert.equal(await aggregator.baseRate(), '0')

    const A_balanceBefore = await lusdToken.balanceOf(A)
    const B_balanceBefore = await lusdToken.balanceOf(B)

    // A redeems 10 LUSD
    await th.redeemCollateralForShutdown(A, contracts, dec(10, 18), GAS_PRICE)

    // Check A's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(A), A_balanceBefore.sub(toBN(dec(10, 18))).toString())

    // Check baseRate is now non-zero
    const baseRate_1 = await aggregator.baseRate()
    assert.isTrue(baseRate_1.gt(toBN('0')))

    // Check LQTY Staking Collateral-fees-per-LQTY-staked before is zero
    const F_Collateral_before = await lqtyStaking.F_Collateral()

    // B redeems 10 LUSD
    await th.redeemCollateralForShutdown(B, contracts, dec(10, 18), GAS_PRICE)

    // Check B's balance has decreased by 10 LUSD
    assert.equal(await lusdToken.balanceOf(B), B_balanceBefore.sub(toBN(dec(10, 18))).toString())

    const F_Collateral_After = await lqtyStaking.F_Collateral()

    // check LQTY Staking balance has increased
    assert.isTrue(F_Collateral_After.gt(F_Collateral_before))
  })

  it("redeemCollateralForShutdown(): a redemption sends the Collateral remainder (CollateralDrawn - CollateralFee) to the redeemer", async () => {
    const redemptionRateAtStart = await aggregator.getRedemptionRateWithDecay();
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    const { totalDebt: W_totalDebt } = await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })

    const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const totalDebt = W_totalDebt.add(A_totalDebt).add(B_totalDebt).add(C_totalDebt)

    const A_balanceBefore = toBN(await collateralToken.balanceOf(A))

    // Confirm baseRate before redemption is 0
    const baseRate = await aggregator.baseRate()
    assert.equal(baseRate, '0')

    // Check total LUSD supply
    const activeLUSD = await activePool.getLUSDDebt()
    const defaultLUSD = await defaultPool.getLUSDDebt()

    const totalLUSDSupply = activeLUSD.add(defaultLUSD)
    th.assertIsApproximatelyEqual(totalLUSDSupply, totalDebt)

    // A redeems 9 LUSD
    const redemptionAmount = toBN(dec(9, 18))
    const tx = await th.redeemCollateralAndGetTxObject(A, contracts, redemptionAmount, GAS_PRICE)

    /*
    At Collateral:USD price of 200:
    CollateralDrawn = (9 / 200) = 0.045 Collateral
    Collateralfee = (0.005 + (1/2) *( 9/260)) * CollateralDrawn = 0.00100384615385 Collateral
    CollateralRemainder = 0.045 - 0.001003... = 0.0439961538462
    */

    const A_balanceAfter = toBN(await collateralToken.balanceOf(A))

    // check A's Collateral balance has increased by 0.045 Collateral 
    const price = await priceFeed.getPrice()
    const par = await relayer.par()
    const collateralDrawn = redemptionAmount.mul(par).div(price)
    
    // get redemtion fee
    const fee = tx.receipt.logs.filter(log => log.event === "Redemption")[0].args[3] // await th.calulateCollateralFee(collateralDrawn, redemptionRateAtStart)

    // The redeemer receives the gross collateral drawn minus the fee
    const expectedCollateralReceived = collateralDrawn.sub(fee)
    
    th.assertIsApproximatelyEqual(
      A_balanceAfter.sub(A_balanceBefore),
      expectedCollateralReceived,
      100000
    )
  })

  it("redeemCollateralForShutdown(): a full redemption (leaving trove with 0 debt), closes the trove", async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    const { netDebt: W_netDebt } = await openTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: dec(10000, 18), extraParams: { from: whale } })

    const { netDebt: A_netDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const { netDebt: D_netDebt } = await openTrove({ ICR: toBN(dec(280, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: D } })
    const redemptionAmount = A_netDebt.add(B_netDebt).add(C_netDebt).add(toBN(dec(10, 18)))

    const A_balanceBefore = toBN(await collateralToken.balanceOf(A))
    const B_balanceBefore = toBN(await collateralToken.balanceOf(B))
    const C_balanceBefore = toBN(await collateralToken.balanceOf(C))

    // whale redeems 360 LUSD.  Expect this to fully redeem A, B, C, and partially redeem D.
    await th.redeemCollateralForShutdown(whale, contracts, redemptionAmount, GAS_PRICE)

    // Check A, B, C have been closed
    assert.isFalse(await sortedTroves.contains(A))
    assert.isFalse(await sortedTroves.contains(B))
    assert.isFalse(await sortedTroves.contains(C))

    // Check D remains active
    assert.isTrue(await sortedTroves.contains(D))
  })

  const redeemCollateral3Full1Partial = async () => {
    // time fast-forwards 1 year, and multisig stakes 1 LQTY
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
    await lqtyToken.approve(lqtyStaking.address, dec(1, 18), { from: multisig })
    await lqtyStaking.stake(dec(1, 18), { from: multisig })

    const { netDebt: W_netDebt } = await openTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: dec(10000, 18), extraParams: { from: whale } })

    const { netDebt: A_netDebt, collateral: A_coll } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    const { netDebt: B_netDebt, collateral: B_coll } = await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    const { netDebt: C_netDebt, collateral: C_coll } = await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const { netDebt: D_netDebt } = await openTrove({ ICR: toBN(dec(280, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: D } })
    const redemptionAmount = A_netDebt.add(B_netDebt).add(C_netDebt).add(toBN(dec(10, 18)))

    const A_balanceBefore = toBN(await collateralToken.balanceOf(A))
    const B_balanceBefore = toBN(await collateralToken.balanceOf(B))
    const C_balanceBefore = toBN(await collateralToken.balanceOf(C))
    const D_balanceBefore = toBN(await collateralToken.balanceOf(D))

    const A_collBefore = await troveManager.getTroveColl(A)
    const B_collBefore = await troveManager.getTroveColl(B)
    const C_collBefore = await troveManager.getTroveColl(C)
    const D_collBefore = await troveManager.getTroveColl(D)

    // Confirm baseRate before redemption is 0
    const baseRate = await aggregator.baseRate()
    assert.equal(baseRate, '0')
    
    // snapshot redemption values
    const price = await priceFeed.getPrice()
    const par = await relayer.par()
    const totalSystemDebt = await th.getEntireSystemDebt(contracts)
    const expectedRedemptionRate = await aggregator.calcRateForRedemption(redemptionAmount, totalSystemDebt)
    
    // whale redeems LUSD.  Expect this to fully redeem A, B, C, and partially redeem D.
    await th.redeemCollateralForShutdown(whale, contracts, redemptionAmount, GAS_PRICE)

    // Check A, B, C have been closed
    assert.isFalse(await sortedTroves.contains(A))
    assert.isFalse(await sortedTroves.contains(B))
    assert.isFalse(await sortedTroves.contains(C))
    assert.isTrue(await troveManager.getTroveStatus(A) == 4 )
    assert.isTrue(await troveManager.getTroveStatus(B) == 4 )
    assert.isTrue(await troveManager.getTroveStatus(C) == 4 )

    // Check D stays active
    assert.isTrue(await sortedTroves.contains(D))
    
    /*
    At Collateral:USD price of 200, with full redemptions from A, B, C:

    CollateralDrawn from A = 100/200 = 0.5 Collateral --> Surplus = (1-0.5) = 0.5
    CollateralDrawn from B = 120/200 = 0.6 Collateral --> Surplus = (1-0.6) = 0.4
    CollateralDrawn from C = 130/200 = 0.65 Collateral --> Surplus = (2-0.65) = 1.35
    */

    const A_balanceAfter = toBN(await collateralToken.balanceOf(A))
    const B_balanceAfter = toBN(await collateralToken.balanceOf(B))
    const C_balanceAfter = toBN(await collateralToken.balanceOf(C))
    const D_balanceAfter = toBN(await collateralToken.balanceOf(D))

    // Check A, B, C's trove collateral balance is zero (fully redeemed-from troves)
    const A_collAfter = await troveManager.getTroveColl(A)
    const B_collAfter = await troveManager.getTroveColl(B)
    const C_collAfter = await troveManager.getTroveColl(C)
    assert.isTrue(A_collAfter.eq(toBN(0)))
    assert.isTrue(B_collAfter.eq(toBN(0)))
    assert.isTrue(C_collAfter.eq(toBN(0)))

    // check D's trove collateral balances have decreased (the partially redeemed-from trove)
    const D_collAfter = await troveManager.getTroveColl(D)
    assert.isTrue(D_collAfter.lt(D_collBefore))

    // Check A, B, C (fully redeemed-from troves), and D's (the partially redeemed-from trove) balance has not changed
    assert.isTrue(A_balanceAfter.eq(A_balanceBefore))
    assert.isTrue(B_balanceAfter.eq(B_balanceBefore))
    assert.isTrue(C_balanceAfter.eq(C_balanceBefore))
    assert.isTrue(D_balanceAfter.eq(D_balanceBefore))

    // D is not closed, so cannot open trove
    await assertRevert(borrowerOperations.openTrove(dec(10, 18), 0, ZERO_ADDRESS, ZERO_ADDRESS, false, { from: D }), 'BorrowerOps: Trove is active')

    return {
      A_netDebt, A_coll,
      B_netDebt, B_coll,
      C_netDebt, C_coll,
      expectedRedemptionRate,
    }
  }

  it("redeemCollateralForShutdown(): emits correct debt and coll values in each redeemed trove's TroveUpdated event", async () => {
    
    const { netDebt: W_netDebt } = await openTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: dec(10000, 18), extraParams: { from: whale } })

    const { netDebt: A_netDebt } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    const { netDebt: B_netDebt } = await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    const { netDebt: C_netDebt } = await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })
    const { totalDebt: D_totalDebt, collateral: D_coll } = await openTrove({ ICR: toBN(dec(280, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: D } })
    const partialAmount = toBN(dec(15, 18))
    const redemptionAmount = A_netDebt.add(B_netDebt).add(C_netDebt).add(partialAmount)

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
    
    const par = await relayer.par()
    const price = await priceFeed.getPrice()
    const totalSystemDebt = await th.getEntireSystemDebt(contracts)
    const expectedRedemptionRate = await aggregator.calcRateForRedemption(redemptionAmount, totalSystemDebt)

    // whale redeems LUSD.  Expect this to fully redeem A, B, C, and partially redeem 15 LUSD from D.
    const redemptionTx = await th.redeemCollateralAndGetTxObject(whale, contracts, redemptionAmount, GAS_PRICE, th._100pct)

    // Check A, B, C have been closed
    assert.isFalse(await sortedTroves.contains(A))
    assert.isFalse(await sortedTroves.contains(B))
    assert.isFalse(await sortedTroves.contains(C))

    // Check D stays active
    assert.isTrue(await sortedTroves.contains(D))

    const troveUpdatedEvents = th.getAllEventsByName(redemptionTx, "TroveUpdated")

    // Get each trove's emitted debt and coll 
    const [A_emittedDebt, A_emittedColl] = th.getDebtAndCollFromTroveUpdatedEvents(troveUpdatedEvents, A)
    const [B_emittedDebt, B_emittedColl] = th.getDebtAndCollFromTroveUpdatedEvents(troveUpdatedEvents, B)
    const [C_emittedDebt, C_emittedColl] = th.getDebtAndCollFromTroveUpdatedEvents(troveUpdatedEvents, C)
    const [D_emittedDebt, D_emittedColl] = th.getDebtAndCollFromTroveUpdatedEvents(troveUpdatedEvents, D)

    // Expect A, B, C to have 0 emitted debt and coll, since they were closed
    assert.equal(A_emittedDebt, '0')
    assert.equal(A_emittedColl, '0')
    assert.equal(B_emittedDebt, '0')
    assert.equal(B_emittedColl, '0')
    assert.equal(C_emittedDebt, '0')
    assert.equal(C_emittedColl, '0')

    // /* Expect D to have lost 15 debt and (at Collateral price of 200) 15/200 = 0.075 Collateral. 
    // So, expect remaining debt = (85 - 15) = 70, and remaining Collateral = 1 - 15/200 = 0.925 remaining. */

    const redeemedDebtForD = toBN(D_totalDebt).sub(toBN(D_emittedDebt)) // actual redeemed debt (post-rounding)

    const gross = redeemedDebtForD.mul(par).div(price)
    const fee = th.calculateCollateralFee(gross, expectedRedemptionRate)

    th.assertIsApproximatelyEqual(D_emittedDebt, D_totalDebt.sub(redeemedDebtForD))
    // D loses the gross collateral drawn, but keeps the fee (so net collateral loss = gross - fee)
    th.assertIsApproximatelyEqual(D_emittedColl, D_coll.sub(gross.sub(fee)))
  })



  it("redeemCollateralForShutdown(): a redemption that closes a trove leaves the trove's Collateral surplus (collateral - Collateral drawn) available for the trove owner to claim", async () => {

    const {
      A_netDebt, A_coll,
      B_netDebt, B_coll,
      C_netDebt, C_coll,
      expectedRedemptionRate,
    } = await redeemCollateral3Full1Partial()
    
    const A_balanceBefore = toBN(await collateralToken.balanceOf(A))
    const B_balanceBefore = toBN(await collateralToken.balanceOf(B))
    const C_balanceBefore = toBN(await collateralToken.balanceOf(C))

    // CollSurplusPool endpoint cannot be called directly
    await assertRevert(collSurplusPool.claimColl(A), 'CollSurplusPool: Caller is not Borrower Operations')

    await borrowerOperations.claimCollateral({ from: A, gasPrice: GAS_PRICE  })
    await borrowerOperations.claimCollateral({ from: B, gasPrice: GAS_PRICE  })
    await borrowerOperations.claimCollateral({ from: C, gasPrice: GAS_PRICE  })

    const price = toBN(await priceFeed.getPrice())
    const par = await relayer.par()

    const A_gross = A_netDebt.mul(par).div(price)
    const A_fee = th.calculateCollateralFee(A_gross, expectedRedemptionRate)
    const A_ExpectedRedemptionAmount = A_gross.sub(A_fee)

    const B_gross = B_netDebt.mul(par).div(price)
    const B_fee = th.calculateCollateralFee(B_gross, expectedRedemptionRate)
    const B_ExpectedRedemptionAmount = B_gross.sub(B_fee)

    const C_gross = C_netDebt.mul(par).div(price)
    const C_fee = th.calculateCollateralFee(C_gross, expectedRedemptionRate)
    const C_ExpectedRedemptionAmount = C_gross.sub(C_fee)
    
    const A_expectedBalance = A_balanceBefore.add(A_coll.sub(A_ExpectedRedemptionAmount));
    const B_expectedBalance = B_balanceBefore.add(B_coll.sub(B_ExpectedRedemptionAmount));
    const C_expectedBalance = C_balanceBefore.add(C_coll.sub(C_ExpectedRedemptionAmount));

    const A_balanceAfter = toBN(await collateralToken.balanceOf(A))
    const B_balanceAfter = toBN(await collateralToken.balanceOf(B))
    const C_balanceAfter = toBN(await collateralToken.balanceOf(C))



    th.assertIsApproximatelyEqual(A_balanceAfter, A_expectedBalance)
    th.assertIsApproximatelyEqual(B_balanceAfter, B_expectedBalance)
    th.assertIsApproximatelyEqual(C_balanceAfter, C_expectedBalance)
  })

  it("redeemCollateralForShutdown(): a redemption that closes a trove leaves the trove's Collateral surplus (collateral - Collateral drawn) available for the trove owner after re-opening trove", async () => {
    const {
      A_netDebt, A_coll: A_collBefore,
      B_netDebt, B_coll: B_collBefore,
      C_netDebt, C_coll: C_collBefore,
      expectedRedemptionRate,
    } = await redeemCollateral3Full1Partial()
    

    const price = await priceFeed.getPrice()
    const par = await relayer.par()

    const A_gross = A_netDebt.mul(par).div(price)
    const B_gross = B_netDebt.mul(par).div(price)
    const C_gross = C_netDebt.mul(par).div(price)

    const A_fee = th.calculateCollateralFee(A_gross, expectedRedemptionRate)
    const B_fee = th.calculateCollateralFee(B_gross, expectedRedemptionRate)
    const C_fee = th.calculateCollateralFee(C_gross, expectedRedemptionRate)

    const A_surplus = A_collBefore.sub(A_gross).add(A_fee)
    const B_surplus = B_collBefore.sub(B_gross).add(B_fee)
    const C_surplus = C_collBefore.sub(C_gross).add(C_fee)

    const { collateral: A_coll } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: A } })
    const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(190, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: B } })
    const { collateral: C_coll } = await openTrove({ ICR: toBN(dec(180, 16)), extraLUSDAmount: dec(100, 18), extraParams: { from: C } })

    const A_collAfter = await troveManager.getTroveColl(A)
    const B_collAfter = await troveManager.getTroveColl(B)
    const C_collAfter = await troveManager.getTroveColl(C)

    assert.isTrue(A_collAfter.eq(A_coll))
    assert.isTrue(B_collAfter.eq(B_coll))
    assert.isTrue(C_collAfter.eq(C_coll))

    // we are getting the surplus from because collSurplusPool.getCollateral(address) is overflowing
    const blockNumber = await web3.eth.getBlockNumber()
    const AsurplusEvents = await collSurplusPool.getPastEvents('CollBalanceUpdated', {
      fromBlock: blockNumber - 10,
      toBlock: blockNumber,
      filter: { _account: A }
    })
    const BsurplusEvents = await collSurplusPool.getPastEvents('CollBalanceUpdated', {
      fromBlock: blockNumber - 10,
      toBlock: blockNumber,
      filter: { _account: B }
    })
    const CsurplusEvents = await collSurplusPool.getPastEvents('CollBalanceUpdated', {
      fromBlock: blockNumber - 10,
      toBlock: blockNumber,
      filter: { _account: C }
    })

    const A_surplus_actual = AsurplusEvents[AsurplusEvents.length - 1].args._newBalance
    const B_surplus_actual = BsurplusEvents[BsurplusEvents.length - 1].args._newBalance
    const C_surplus_actual = CsurplusEvents[CsurplusEvents.length - 1].args._newBalance

    th.assertIsApproximatelyEqual(A_surplus_actual, A_surplus)
    th.assertIsApproximatelyEqual(B_surplus_actual, B_surplus)
    th.assertIsApproximatelyEqual(C_surplus_actual, C_surplus)
  })

  it('redeemCollateralForShutdown(): reverts if fee eats up all returned collateral', async () => {
    // --- SETUP ---
    const { lusdAmount } = await openTrove({ ICR: toBN(dec(200, 16)), extraLUSDAmount: dec(1, 24), extraParams: { from: alice } })
    await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: bob } })

    const price = await priceFeed.getPrice()
    assert.equal(price, dec(200, 18))

    // --- TEST ---

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // keep redeeming until we get the base rate to the ceiling of 100%
    // this takes less iter than LiquityV1 since here is no borrowing fee and
    // more debt is redeemed so max fee is it in less iter
    for (let i = 0; i < 1; i++) {
      // Find hints for redeeming
      const {
        firstRedemptionHint,
        partialRedemptionHintNICR
      } = await hintHelpers.getRedemptionHints(lusdAmount, price, 0)

      // Don't pay for gas, as it makes it easier to calculate the received Ether
      const redemptionTx = await troveManager.redeemCollateralForShutdown(
        lusdAmount,
        firstRedemptionHint,
        ZERO_ADDRESS,
        alice,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        partialRedemptionHintNICR,
        0, th._100pct,
        {
          from: alice,
          gasPrice: GAS_PRICE
        }
      )
      await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: bob } })
      await collateralToken.approve(activePool.address, lusdAmount.mul(mv._1e18BN).div(price), { from: alice })
      await borrowerOperations.adjustTrove(lusdAmount.mul(mv._1e18BN).div(price), 0, lusdAmount, true, false, alice, alice, { from: alice })
    }

    const {
      firstRedemptionHint,
      partialRedemptionHintNICR
    } = await hintHelpers.getRedemptionHints(lusdAmount, price, 0)

    await assertRevert(
      troveManager.redeemCollateralForShutdown(
        lusdAmount,
        firstRedemptionHint,
        ZERO_ADDRESS,
        alice,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        partialRedemptionHintNICR,
        0, th._100pct,
        {
          from: alice,
          gasPrice: GAS_PRICE
        }
      ),
      'TroveManager: Fee would eat up all returned collateral'
    )
  })
  it("redeemCollateralForShutdown(): shielded trove is not redeemed against", async () => {
    await rateControl.setCoBias(0)
    const collateralAmount = dec(1000, 'ether')
    await collateralToken.approve(activePool.address, collateralAmount, { from: A })
    await collateralToken.approve(activePool.address, collateralAmount, { from: B })
    await collateralToken.approve(activePool.address, collateralAmount, { from: C })
    tx_a = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(10000, 18)), A, A, false, { from: A })
    tx_b = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(20000, 18)), B, B, false, { from: B })
    tx_c = await borrowerOperations.openTrove(collateralAmount, await getOpenTroveLUSDAmount( dec(30000, 18)), C, C, true, { from: C })

    nCompDebt_A = toBN(th.getRawEventArgByName(tx_a, borrowerOperationsInterface, borrowerOperations.address, "TroveUpdated", "_debt"))
    nCompDebt_B = toBN(th.getRawEventArgByName(tx_b, borrowerOperationsInterface, borrowerOperations.address, "TroveUpdated", "_debt"))
    nCompDebt_C = toBN(th.getRawEventArgByName(tx_c, borrowerOperationsInterface, borrowerOperations.address, "TroveUpdated", "_debt"))

    const A_debt = await troveManager.getTroveDebt(A)
    const B_debt = await troveManager.getTroveDebt(B)
    const C_debt = await troveManager.getTroveDebt(C)

    activeDebt = await activePool.getLUSDDebt()
    activeShieldedDebt = await activeShieldedPool.getLUSDDebt()

    assert.isTrue(activeDebt.eq(A_debt.add(B_debt)))
    assert.isTrue(activeShieldedDebt.eq(C_debt))

    const price = await priceFeed.getPrice();

    // shielded trove is above HCR
    assert.isTrue((await troveManager.getCurrentICR(C, price)).gt((await troveManager.HCR())))

    // A and C send all their tokens to B
    await lusdToken.transfer(B, await lusdToken.balanceOf(A), {from: A})
    await lusdToken.transfer(B, await lusdToken.balanceOf(C), {from: C})
    
    await aggregator.setBaseRate(0) 

    // skip bootstrapping phase
    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)

    // Before redemption

    // LUSD redemption is 55000 US
    const LUSDRedemption = dec(55000, 18)

    const tx1 = await th.redeemCollateralAndGetTxObject(B, contracts, LUSDRedemption, th._100pct)

    // Check A, B closed and C remains active
    assert.isFalse(await sortedTroves.contains(A))
    assert.isFalse(await sortedTroves.contains(B))
    assert.isTrue(await sortedShieldedTroves.contains(C))

    //const expectedDebt_A = toBN(dec(4600, 18))//.mul(par).div(toBN(dec(1, 18)))
    // A's remaining debt = 29800 + 19800 + 9800 + 200 - 55000 = 4600
    const expectedDebt_A = toBN('0')
    const A_final_debt = await troveManager.getTroveDebt(A)
    // console.log("A_final_debt", A_final_debt.toString())
    assert.isTrue(A_final_debt.eq(expectedDebt_A))

    // C lost no debt
    const C_final_debt = await troveManager.getTroveDebt(C)
    assert.isTrue(C_final_debt.eq(C_debt))
  })

  it("getPendingLUSDDebtReward(): Returns 0 if there is no pending LUSDDebt reward", async () => {
    // Make some troves
    const { totalDebt } = await openTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: dec(100, 18), extraParams: { from: defaulter_1 } })

    await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })

    await openTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: totalDebt, extraParams: { from: whale } })
    // add 2 to totalDebt since SP now requires a minimum of 1 being leftover
    await stabilityPool.provideToSP(totalDebt.add(toBN(dec(2, 18))), ZERO_ADDRESS, { from: whale })

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    tx = await liquidations.liquidate(defaulter_1)
    const [liquidatedDebt, liquidatedColl, gasComp] = th.getEmittedLiquidationValues(tx)

    // Confirm defaulter_1 liquidated
    assert.isFalse(await sortedTroves.contains(defaulter_1))

    // Confirm there are no pending rewards from liquidation
    const current_L_LUSDDebt = await rewards.L_LUSDDebt()
    assert.equal(current_L_LUSDDebt, 0)

    const carolSnapshot_L_LUSDDebt = (await rewards.rewardSnapshots(carol))[1]
    assert.equal(carolSnapshot_L_LUSDDebt, 0)

    const carol_PendingLUSDDebtReward = await rewards.getPendingLUSDDebtReward(carol)
    assert.equal(carol_PendingLUSDDebtReward, 0)
  })

  it("getPendingCollateralReward(): Returns 0 if there is no pending Collateral reward", async () => {
    // make some troves
    const { totalDebt } = await openTrove({ ICR: toBN(dec(2, 18)), extraLUSDAmount: dec(100, 18), extraParams: { from: defaulter_1 } })

    await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: dec(20, 18), extraParams: { from: carol } })

    await openTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: totalDebt, extraParams: { from: whale } })
    // add 2 to totalDebt since SP now requires a minimum of 1 being leftover
    await stabilityPool.provideToSP(totalDebt.add(toBN(dec(2, 18))), ZERO_ADDRESS, { from: whale })

    // Price drops
    await priceFeed.setPrice(dec(100, 18))

    await liquidations.liquidate(defaulter_1)

    // Confirm defaulter_1 liquidated
    assert.isFalse(await sortedTroves.contains(defaulter_1))

    // Confirm there are no pending rewards from liquidation
    const current_L_Coll = await rewards.L_Coll()
    assert.equal(current_L_Coll, 0)

    const carolSnapshot_L_Coll = (await rewards.rewardSnapshots(carol))[0]
    assert.equal(carolSnapshot_L_Coll, 0)

    const carol_PendingCollateralReward = await rewards.getPendingCollateralReward(carol)
    assert.equal(carol_PendingCollateralReward, 0)
  })
    })
})