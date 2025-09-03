const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")
const LiquidationsTester = artifacts.require("./LiquidationsTester.sol")
const TroveManagerTester = artifacts.require("./TroveManagerTester.sol")
const LUSDTokenTester = artifacts.require("./LUSDTokenTester.sol")

const th = testHelpers.TestHelper
const dec = th.dec
const toBN = th.toBN
const assertRevert = th.assertRevert
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues


/* NOTE: Some tests involving ETH redemption fees do not test for specific fee values.
 * Some only test that the fees are non-zero when they should occur.
 *
 * Specific ETH gain values will depend on the final fee schedule used, and the final choices for
 * the parameter BETA in the TroveManager, which is still TBD based on economic modelling.
 * 
 */
contract('TroveManager', async accounts => {

  const ZERO_ADDRESS = th.ZERO_ADDRESS
  const [owner, A, B, C, D, E, F] = accounts.slice(0, 7);

  const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  let priceFeed
  let lusdToken
  let sortedTroves
  let troveManager
  let activePool
  let stabilityPool
  let collSurplusPool
  let defaultPool
  let borrowerOperations
  let liquidations
  let collateralToken

  let contracts

  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
 
  const getSnapshotsRatio = async () => {
    const ratio = (await rewards.totalStakesSnapshot())
      .mul(toBN(dec(1, 18)))
      .div((await rewards.totalCollateralSnapshot()))

    return ratio
  }

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore()
    contracts.liquidations = await LiquidationsTester.new()
    contracts.troveManager = await TroveManagerTester.new()
    contracts.lusdToken = await LUSDTokenTester.new(
      contracts.troveManager.address,
      contracts.liquidations.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address,
      contracts.globalFeeRouter.address
    )
    const LQTYContracts = await deploymentHelper.deployLQTYContracts(bountyAddress, lpRewardsAddress, multisig)

    priceFeed = contracts.priceFeedTestnet
    lusdToken = contracts.lusdToken
    sortedTroves = contracts.sortedTroves
    liquidations = contracts.liquidations
    troveManager = contracts.troveManager
    rewards = contracts.rewards
    activePool = contracts.activePool
    stabilityPool = contracts.stabilityPool
    defaultPool = contracts.defaultPool
    collSurplusPool = contracts.collSurplusPool
    borrowerOperations = contracts.borrowerOperations
    hintHelpers = contracts.hintHelpers
    collateralToken = contracts.collateralToken
    lqtyStaking = LQTYContracts.lqtyStaking
    lqtyToken = LQTYContracts.lqtyToken
    communityIssuance = LQTYContracts.communityIssuance
    lockupContractFactory = LQTYContracts.lockupContractFactory

    await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
    await deploymentHelper.connectLQTYContracts(LQTYContracts)
    await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)

    await th.mintCollateralTokensAndApproveActivePool(contracts, [A, B, C, D, E, F], toBN(dec(1000, 31)))
  })

  it("A given trove's stake decline is negligible with adjustments and tiny liquidations", async () => {
    await priceFeed.setPrice(dec(100, 18))
  
    // Make 1 mega troves A at ~50% total collateral
    await borrowerOperations.openTrove(dec(2, 29), await getOpenTroveLUSDAmount(dec(1, 31)), ZERO_ADDRESS, ZERO_ADDRESS, false, { from: A })
    
    // Make 5 large troves B, C, D, E, F at ~10% total collateral
    await borrowerOperations.openTrove(dec(4, 28), await getOpenTroveLUSDAmount(dec(2, 30)), ZERO_ADDRESS, ZERO_ADDRESS, false, { from: B })
    await borrowerOperations.openTrove(dec(4, 28), await getOpenTroveLUSDAmount(dec(2, 30)), ZERO_ADDRESS, ZERO_ADDRESS, false, { from: C })
    await borrowerOperations.openTrove(dec(4, 28), await getOpenTroveLUSDAmount(dec(2, 30)), ZERO_ADDRESS, ZERO_ADDRESS, false, { from: D })
    await borrowerOperations.openTrove(dec(4, 28), await getOpenTroveLUSDAmount(dec(2, 30)), ZERO_ADDRESS, ZERO_ADDRESS, false, { from: E })
    await borrowerOperations.openTrove(dec(4, 28), await getOpenTroveLUSDAmount(dec(2, 30)), ZERO_ADDRESS, ZERO_ADDRESS, false, { from: F })
  
    // Make 10 tiny troves at relatively negligible collateral (~1e-9 of total)
    const tinyTroves = accounts.slice(10, 20)
    for (account of tinyTroves) {
      await collateralToken.mint(account, dec(2, 20), { from: owner })
      await collateralToken.approve(activePool.address, dec(2, 20), { from: account })
      await borrowerOperations.openTrove(dec(2, 20), await getOpenTroveLUSDAmount(dec(1, 22)), ZERO_ADDRESS, ZERO_ADDRESS, false, { from: account })
    }

    // liquidate 1 trove at ~50% total system collateral
    await priceFeed.setPrice(dec(50, 18))
    //assert.isTrue(await troveManager.checkRecoveryMode(await priceFeed.getPrice()))
    assert.isTrue(await th.checkRecoveryMode(contracts))
    await liquidations.liquidate(A)

    console.log(`totalStakesSnapshot after L1: ${await rewards.totalStakesSnapshot()}`)
    console.log(`totalCollateralSnapshot after L1: ${await rewards.totalCollateralSnapshot()}`)
    console.log(`Snapshots ratio after L1: ${await getSnapshotsRatio()}`)
    console.log(`B pending ETH reward after L1: ${await rewards.getPendingCollateralReward(B)}`)
    console.log(`B stake after L1: ${(await troveManager.Troves(B))[2]}`)

    // adjust trove B 1 wei: apply rewards
    
    await borrowerOperations.adjustTrove(0, 0, 1, false, false, ZERO_ADDRESS, ZERO_ADDRESS, {from: B})  // B repays 1 wei
    console.log(`B stake after A1: ${(await troveManager.Troves(B))[2]}`)
    console.log(`Snapshots ratio after A1: ${await getSnapshotsRatio()}`)

    // Loop over tiny troves, and alternately:
    // - Liquidate a tiny trove
    // - Adjust B's collateral by 1 wei
    for (let [idx, trove] of tinyTroves.entries()) {
      await liquidations.liquidate(trove)
      console.log(`B stake after L${idx + 2}: ${(await troveManager.Troves(B))[2]}`)
      console.log(`Snapshots ratio after L${idx + 2}: ${await getSnapshotsRatio()}`)
      await borrowerOperations.adjustTrove(0, 0, 1, false, false, ZERO_ADDRESS, ZERO_ADDRESS, {from: B})  // A repays 1 wei
      console.log(`B stake after A${idx + 2}: ${(await troveManager.Troves(B))[2]}`)
    }
  })

  // TODO: stake decline for adjustments with sizable liquidations, for comparison
})
