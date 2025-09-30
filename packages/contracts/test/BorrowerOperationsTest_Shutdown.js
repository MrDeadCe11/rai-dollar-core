const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")

const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol")
const NonPayable = artifacts.require('NonPayable.sol')
const AggregatorTester = artifacts.require("AggregatorTester")
const LiquidationsTester = artifacts.require("LiquidationsTester")
const TroveManagerTester = artifacts.require("TroveManagerTester")
const LUSDTokenTester = artifacts.require("./LUSDTokenTester")
const TroveManagerLib = artifacts.require("./Dependencies/TroveManagerLib.sol")

const th = testHelpers.TestHelper

const dec = th.dec
const toBN = th.toBN
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

const ZERO_ADDRESS = th.ZERO_ADDRESS
const assertRevert = th.assertRevert

/* NOTE: Some of the borrowing tests do not test for specific LUSD fee values. They only test that the
 * fees are non-zero when they should occur, and that they decay over time.
 *
 * Specific LUSD fee values will depend on the final fee schedule used, and the final choice for
 *  the parameter MINUTE_DECAY_FACTOR in the TroveManager, which is still TBD based on economic
 * modelling.
 * 
 */

contract('BorrowerOperations - Shutdown', async accounts => {

  const [
    owner, alice, bob, carol, dennis, whale,
    A, B, C, D, E, F, G, H,
    // defaulter_1, defaulter_2,
    frontEnd_1, frontEnd_2, frontEnd_3] = accounts;

    const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  // const frontEnds = [frontEnd_1, frontEnd_2, frontEnd_3]

  let priceFeed
  let lusdToken
  let sortedTroves
  let troveManager
  let rewards
  let activePool
  let stabilityPool
  let defaultPool
  let borrowerOperations
  let lqtyStaking
  let lqtyToken
  let collateralToken

  let contracts

  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const getNetBorrowingAmount = async (debtWithFee) => th.getNetBorrowingAmount(contracts, debtWithFee)
  const getActualDebtFromComposite = async (compositeDebt) => th.getActualDebtFromComposite(compositeDebt, contracts)
  const openTrove = async (params) => th.openTrove(contracts, params)
  const getTroveEntireColl = async (trove) => th.getTroveEntireColl(contracts, trove)
  const getTroveEntireDebt = async (trove) => th.getTroveEntireDebt(contracts, trove)
  const getTroveStake = async (trove) => th.getTroveStake(contracts, trove)

  let LUSD_GAS_COMPENSATION
  let MIN_NET_DEBT

  before(async () => {
    const lib = await TroveManagerLib.new();
    await TroveManagerTester.link(lib);
  })


  const testCorpus = ({ withProxy = false }) => {
    beforeEach(async () => {
      contracts = await deploymentHelper.deployLiquityCore()
      contracts.borrowerOperations = await BorrowerOperationsTester.new()
      contracts.aggregator = await AggregatorTester.new()
      contracts.liquidations = await LiquidationsTester.new()
      contracts.troveManager = await TroveManagerTester.new()
      contracts = await deploymentHelper.deployLUSDTokenTester(contracts)
      const LQTYContracts = await deploymentHelper.deployLQTYTesterContractsHardhat(bountyAddress, lpRewardsAddress, multisig)

      await deploymentHelper.connectLQTYContracts(LQTYContracts)
      await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
      await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)

      if (withProxy) {
        const users = [alice, bob, carol, dennis, whale, A, B, C, D, E]
        await deploymentHelper.deployProxyScripts(contracts, LQTYContracts, owner, users)
      }
      await th.batchMintCollateralTokensAndApproveActivePool(contracts, [alice, bob, carol, dennis, whale, A, B, C, D, E], toBN(dec(1000, 30)))
      
      priceFeed = contracts.priceFeedTestnet
      lusdToken = contracts.lusdToken
      sortedTroves = contracts.sortedTroves
      aggregator = contracts.aggregator
      liquidations = contracts.liquidations
      troveManager = contracts.troveManager
      rewards = contracts.rewards
      activePool = contracts.activePool
      stabilityPool = contracts.stabilityPool
      defaultPool = contracts.defaultPool
      borrowerOperations = contracts.borrowerOperations
      hintHelpers = contracts.hintHelpers

      lqtyStaking = LQTYContracts.lqtyStaking
      lqtyToken = LQTYContracts.lqtyToken
      communityIssuance = LQTYContracts.communityIssuance
      lockupContractFactory = LQTYContracts.lockupContractFactory
      collateralToken = contracts.collateralToken

      LUSD_GAS_COMPENSATION = await borrowerOperations.LUSD_GAS_COMPENSATION()
      MIN_NET_DEBT = await borrowerOperations.MIN_NET_DEBT()
    })

    describe('shutdown', async () => {
      it('shuts down the system when the oracle fails', async () => {
        await priceFeed.setOracleFailure(true)
        await priceFeed.fetchPrice()
        assert.isTrue(await troveManager.isShutdown())
      })

      it('shuts down the system when the TCR is less than the SCR', async () => {
        await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: alice } })
        await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: bob } })
        await priceFeed.setPrice(toBN(dec(1, 10)))
        await borrowerOperations.shutdown()
        assert.isTrue(await troveManager.isShutdown())
      })

      it('reverts when the TCR is >= SCR', async () => {
        try {
          await borrowerOperations.shutdown()
        } catch (err) {
          assert.include(err.message, 'TCR must be less than SCR')
        }
        assert.isFalse(await troveManager.isShutdown())
      })
    })

    describe('blocked operations after shutdown', async () => {
      it('openTrove reverts after shutdown', async () => {
        await priceFeed.setOracleFailure(true)
        await priceFeed.fetchPrice()
        assert.isTrue(await troveManager.isShutdown())

        await assertRevert(
          borrowerOperations.openTrove(dec(1, 'ether'), MIN_NET_DEBT, ZERO_ADDRESS, ZERO_ADDRESS, false, { from: carol }),
          'BorrowerOps: System is shutdown'
        )
      })

      it('adjustTrove reverts after shutdown', async () => {
        await borrowerOperations.openTrove(dec(100, 'ether'), MIN_NET_DEBT, ZERO_ADDRESS, ZERO_ADDRESS, false, { from: alice })
        await priceFeed.setOracleFailure(true)
        await priceFeed.fetchPrice()
        assert.isTrue(await troveManager.isShutdown())

        await assertRevert(
          borrowerOperations.adjustTrove(dec(1, 'ether'), 0, 0, false, false, ZERO_ADDRESS, ZERO_ADDRESS, { from: alice }),
          'BorrowerOps: System is shutdown'
        )
      })
    })
  }
})