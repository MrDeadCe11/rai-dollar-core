const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")

const th = testHelpers.TestHelper
const dec = th.dec
const toBN = th.toBN
const getDifference = th.getDifference
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

const TroveManagerTester = artifacts.require("TroveManagerTester")
const TroveManagerLib = artifacts.require("./Dependencies/TroveManagerLib.sol")
const LiquidationsTester = artifacts.require("LiquidationsTester")
const LUSDToken = artifacts.require("LUSDToken")
const PriceFeedTestnetV2 = artifacts.require("PriceFeedTestnetV2")

contract('TroveManager - Shutdown', async accounts => {

  const [
    owner,
    alice, bob, carol, dennis, erin, freddy, greta, harry, ida,
    A, B, C, D, E,
    whale, defaulter_1, defaulter_2, defaulter_3, defaulter_4] = accounts;

    const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  let priceFeed
  let lusdToken
  let sortedTroves
  let troveManager
  let nameRegistry
  let activePool
  let stabilityPool
  let defaultPool
  let functionCaller
  let borrowerOperations
  let collateralToken
  let relayer

  let contracts

  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const getNetBorrowingAmount = async (debtWithFee) => th.getNetBorrowingAmount(contracts, debtWithFee)
  const openTrove = async (params) => th.openTrove(contracts, params)

  let lib;
  before(async () => {
    lib = await TroveManagerLib.new();
    await TroveManagerTester.link(lib);
  });
  
  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore()
    contracts.liquidations = await LiquidationsTester.new()
    contracts.troveManager = await TroveManagerTester.new()
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

    await deploymentHelper.connectLQTYContracts(LQTYContracts)
    await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
    await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)

    await th.batchMintCollateralTokensAndApproveActivePool(contracts, [owner,
      alice, bob, carol, dennis, erin, freddy, greta, harry, ida,
      A, B, C, D, E,
      whale, defaulter_1, defaulter_2, defaulter_3, defaulter_4], toBN(dec(1000, 26)))
  })

  async function calcSCRPrice() {
    const totalColl = await troveManager.getEntireSystemColl();
  const accRate = await troveManager.accumulatedRate();
  const accShieldRate = await troveManager.accumulatedShieldRate();
  const totalDebt = await troveManager.getEntireSystemDebt(accRate, accShieldRate);
  const par = await relayer.par();
  const SCR = toBN(dec(110, 16)); // 1.10e18
  // price* = SCR * totalDebt * par / (totalColl * 1e18)
  const numerator = SCR.mul(totalDebt).mul(par);
  const denom = totalColl.mul(toBN(dec(1, 18)));
  const scrPrice = numerator.div(denom);
  // set just below
  return scrPrice
  }
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
      // calculate tcr
      const scrPrice = await calcSCRPrice()
      console.log('scrPrice', scrPrice.toString())
      await priceFeed.setPrice(scrPrice.mul(toBN(95)).div(toBN(100)))
      await borrowerOperations.shutdown()
      assert.isTrue(await troveManager.isShutdown())
      const alice_LUSD_before = toBN(await lusdToken.balanceOf(alice))
      const alice_coll_before = toBN(await collateralToken.balanceOf(alice))
      await troveManager.redeemCollateralForShutdown(toBN(dec(100, 18)), '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0, 100, 0, { from: alice })
      const alice_coll_after = toBN(await collateralToken.balanceOf(alice))
      const alice_LUSD_after = toBN(await lusdToken.balanceOf(alice))
      console.log('alice_LUSD_before', alice_LUSD_before.toString())
      console.log('alice_LUSD_after', alice_LUSD_after.toString())
      console.log('alice_coll_before', alice_coll_before.toString())
      console.log('alice_coll_after', alice_coll_after.toString())
      assert.isTrue(alice_LUSD_after.lt(alice_LUSD_before))
      assert.isTrue(alice_coll_before.lt(alice_coll_after))
    })
})