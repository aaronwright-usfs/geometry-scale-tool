import { useEffect, useMemo, useRef, useState } from 'react'
import Map from '@arcgis/core/Map'
import MapView from '@arcgis/core/views/MapView'
import FeatureLayer from '@arcgis/core/layers/FeatureLayer'
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer'
import Graphic from '@arcgis/core/Graphic'
import Point from '@arcgis/core/geometry/Point'
import Polygon from '@arcgis/core/geometry/Polygon'
import * as geometryEngine from '@arcgis/core/geometry/geometryEngine'
import * as affineTransformOperator from '@arcgis/core/geometry/operators/affineTransformOperator'
import Transformation from '@arcgis/core/geometry/operators/support/Transformation'
import OAuthInfo from '@arcgis/core/identity/OAuthInfo'
import esriId from '@arcgis/core/identity/IdentityManager'
import './App.css'

const DEFAULT_PORTAL_URL = 'https://usfs.maps.arcgis.com'
const DEFAULT_LAYER_URL =
  'https://services1.arcgis.com/gGHDlz6USftL5Pau/arcgis/rest/services/extents/FeatureServer/0'

type Runtime = {
  view: MapView
  layer: FeatureLayer
  graphicsLayer: GraphicsLayer
  objectIdField: string
  selectedObjectId: number | null
  selectedGeometry: Polygon | null
  previewGeometry: Polygon | null
  centroid: Point | null
  baseDistance: number
  handleGraphic: Graphic | null
  previewGraphic: Graphic | null
  centerGraphic: Graphic | null
  highlightHandle: { remove: () => void } | null
  pointerHandles: Array<{ remove: () => void }>
}

declare global {
  interface Window {
    __esriId?: typeof esriId
  }
}

const getConfig = () => {
  const params = new URLSearchParams(window.location.search)
  return {
    portalUrl: params.get('portalUrl') || DEFAULT_PORTAL_URL,
    layerUrl: params.get('layerUrl') || DEFAULT_LAYER_URL,
    where: params.get('where') || '1=1',
    clientId: params.get('clientId') || '',
  }
}

const getCentroid = (polygon: Polygon): Point => {
  const centroid = polygon.centroid
  if (centroid) {
    return centroid
  }
  const extent = polygon.extent
  if (extent) {
    return extent.center
  }
  const [firstVertex] = polygon.rings[0] ?? [[0, 0]]
  return new Point({
    x: firstVertex[0],
    y: firstVertex[1],
    spatialReference: polygon.spatialReference,
  })
}

const getHandlePoint = (polygon: Polygon): Point => {
  const extent = polygon.extent
  if (!extent) {
    return getCentroid(polygon)
  }
  return new Point({
    x: extent.xmax,
    y: (extent.ymax + extent.ymin) / 2,
    spatialReference: polygon.spatialReference,
  })
}

const getDistance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

const scalePolygon = (polygon: Polygon, scaleFactor: number, centroid: Point): Polygon | null => {
  const engine = geometryEngine as unknown as {
    scale?: (geometry: Polygon, sx: number, sy: number, origin: Point) => Polygon | null
  }
  if (engine.scale) {
    return engine.scale(polygon, scaleFactor, scaleFactor, centroid)
  }

  const transform = new Transformation()
  transform.shift(-centroid.x, -centroid.y).scale(scaleFactor, scaleFactor).shift(centroid.x, centroid.y)
  const transformed = affineTransformOperator.execute(polygon, transform)
  return transformed.type === 'polygon' ? (transformed as Polygon) : null
}

function App() {
  const mapDivRef = useRef<HTMLDivElement | null>(null)
  const runtimeRef = useRef<Runtime | null>(null)
  const draggingRef = useRef(false)

  const config = useMemo(() => getConfig(), [])

  const [authStatus, setAuthStatus] = useState(
    config.clientId ? 'Checking sign-in status…' : 'Provide ?clientId=<OAuthAppId> to enable sign-in.',
  )
  const [isSignedIn, setIsSignedIn] = useState(false)
  const [selectedObjectId, setSelectedObjectId] = useState<number | null>(null)
  const [scaleFactor, setScaleFactor] = useState(1)
  const [statusMessage, setStatusMessage] = useState('Initializing map…')
  const [iframeAuthError, setIframeAuthError] = useState(false)

  const isInIframe = window.self !== window.top

  useEffect(() => {
    let isCancelled = false

    const init = async () => {
      if (!mapDivRef.current) {
        return
      }

      if (config.clientId) {
        const oauthInfo = new OAuthInfo({
          appId: config.clientId,
          portalUrl: config.portalUrl,
          popup: true,
          popupCallbackUrl: `${window.location.origin}${import.meta.env.BASE_URL}oauth-callback.html`,
        })
        esriId.registerOAuthInfos([oauthInfo])
        window.__esriId = esriId

        try {
          await esriId.checkSignInStatus(`${config.portalUrl}/sharing`)
          if (!isCancelled) {
            setIsSignedIn(true)
            setAuthStatus('Signed in')
          }
        } catch {
          if (!isCancelled) {
            setIsSignedIn(false)
            setAuthStatus('Not signed in')
          }
        }
      }

      const layer = new FeatureLayer({
        url: config.layerUrl,
        outFields: ['*'],
        definitionExpression: config.where,
      })
      const graphicsLayer = new GraphicsLayer()

      const map = new Map({
        basemap: 'streets-vector',
        layers: [layer, graphicsLayer],
      })

      const view = new MapView({
        container: mapDivRef.current,
        map,
      })

      await Promise.all([view.when(), layer.load()])
      if (layer.fullExtent) {
        await view.goTo(layer.fullExtent)
      }

      const objectIdField = layer.objectIdField

      const runtime: Runtime = {
        view,
        layer,
        graphicsLayer,
        objectIdField,
        selectedObjectId: null,
        selectedGeometry: null,
        previewGeometry: null,
        centroid: null,
        baseDistance: 1,
        handleGraphic: null,
        previewGraphic: null,
        centerGraphic: null,
        highlightHandle: null,
        pointerHandles: [],
      }

      runtimeRef.current = runtime

      const updateOverlay = (polygon: Polygon, preview?: Polygon) => {
        const centroid = getCentroid(polygon)
        const handlePoint = getHandlePoint(preview ?? polygon)

        runtime.centroid = centroid
        runtime.baseDistance = Math.max(getDistance(centroid, getHandlePoint(polygon)), 0.0001)

        if (!runtime.centerGraphic) {
          runtime.centerGraphic = new Graphic({
            symbol: {
              type: 'simple-marker',
              style: 'x',
              color: '#1d4ed8',
              size: 12,
              outline: {
                color: '#1d4ed8',
                width: 2,
              },
            },
          })
          runtime.graphicsLayer.add(runtime.centerGraphic)
        }
        runtime.centerGraphic.geometry = centroid

        if (!runtime.handleGraphic) {
          runtime.handleGraphic = new Graphic({
            symbol: {
              type: 'simple-marker',
              style: 'circle',
              color: '#ef4444',
              size: 14,
              outline: {
                color: '#ffffff',
                width: 2,
              },
            },
          })
          runtime.graphicsLayer.add(runtime.handleGraphic)
        }
        runtime.handleGraphic.geometry = handlePoint

        if (preview) {
          if (!runtime.previewGraphic) {
            runtime.previewGraphic = new Graphic({
              symbol: {
                type: 'simple-fill',
                color: [37, 99, 235, 0.2],
                outline: {
                  color: [37, 99, 235, 1],
                  width: 2,
                },
              },
            })
            runtime.graphicsLayer.add(runtime.previewGraphic)
          }
          runtime.previewGraphic.geometry = preview
        } else if (runtime.previewGraphic) {
          runtime.graphicsLayer.remove(runtime.previewGraphic)
          runtime.previewGraphic = null
        }
      }

      const clearSelection = () => {
        runtime.highlightHandle?.remove()
        runtime.highlightHandle = null
        runtime.selectedGeometry = null
        runtime.previewGeometry = null
        runtime.selectedObjectId = null
        runtime.centroid = null
        runtime.baseDistance = 1
        runtime.graphicsLayer.removeAll()
        runtime.handleGraphic = null
        runtime.previewGraphic = null
        runtime.centerGraphic = null
        setSelectedObjectId(null)
        setScaleFactor(1)
      }

      const selectFeature = async (objectId: number) => {
        const featureSet = await layer.queryFeatures({
          objectIds: [objectId],
          outFields: ['*'],
          returnGeometry: true,
        })

        const feature = featureSet.features[0]
        if (!feature || !feature.geometry || feature.geometry.type !== 'polygon') {
          setStatusMessage('Selected feature is not a polygon.')
          clearSelection()
          return
        }

        runtime.selectedObjectId = objectId
        runtime.selectedGeometry = feature.geometry as Polygon
        runtime.previewGeometry = null

        const layerView = await view.whenLayerView(layer)
        runtime.highlightHandle?.remove()
        runtime.highlightHandle = layerView.highlight(feature)

        updateOverlay(runtime.selectedGeometry)
        setSelectedObjectId(objectId)
        setScaleFactor(1)
        setStatusMessage(`Selected feature ObjectID ${objectId}. Drag the red handle to scale.`)
      }

      runtime.pointerHandles.push(
        view.on('click', async (event) => {
          if (draggingRef.current) {
            return
          }

          const hit = await view.hitTest(event, { include: [layer] })
          const graphicHit = hit.results.find((result) => result.type === 'graphic')
          const graphic = graphicHit?.graphic
          if (!graphic) {
            clearSelection()
            setStatusMessage('Selection cleared.')
            return
          }

          const objectId = Number(graphic.attributes?.[objectIdField])
          if (!Number.isFinite(objectId)) {
            setStatusMessage('Unable to determine ObjectID for selected feature.')
            return
          }

          await selectFeature(objectId)
        }),
      )

      runtime.pointerHandles.push(
        view.on('pointer-down', async (event) => {
          const current = runtimeRef.current
          if (!current?.handleGraphic || !current.selectedGeometry) {
            return
          }

          const hit = await view.hitTest(event, { include: [current.graphicsLayer] })
          const hitGraphic = hit.results.find((result) => result.type === 'graphic')?.graphic
          if (hitGraphic !== current.handleGraphic) {
            return
          }

          draggingRef.current = true
          event.stopPropagation()
          setStatusMessage('Dragging scale handle…')
        }),
      )

      runtime.pointerHandles.push(
        view.on('pointer-move', (event) => {
          const current = runtimeRef.current
          if (!draggingRef.current || !current?.selectedGeometry || !current.centroid) {
            return
          }

          const pointerPoint = view.toMap({ x: event.x, y: event.y })
          if (!pointerPoint || pointerPoint.type !== 'point') {
            return
          }

          const distance = getDistance(current.centroid, pointerPoint as Point)
          const nextScaleFactor = Math.max(distance / current.baseDistance, 0.05)
          const scaled = scalePolygon(current.selectedGeometry, nextScaleFactor, current.centroid)

          if (!scaled || scaled.type !== 'polygon') {
            return
          }

          current.previewGeometry = scaled as Polygon
          updateOverlay(current.selectedGeometry, current.previewGeometry)
          setScaleFactor(nextScaleFactor)
          setStatusMessage(`Preview scale factor: ${nextScaleFactor.toFixed(3)}`)
          event.stopPropagation()
        }),
      )

      runtime.pointerHandles.push(
        view.on('pointer-up', () => {
          if (!draggingRef.current) {
            return
          }
          draggingRef.current = false
          if (runtimeRef.current?.previewGeometry) {
            setStatusMessage('Drag complete. Use Save to persist edits or Cancel to discard.')
          }
        }),
      )

      if (!isCancelled) {
        setStatusMessage('Map ready. Click a polygon to select it.')
      }
    }

    init().catch((error: unknown) => {
      if (isCancelled) {
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      setStatusMessage(`Initialization failed: ${message}`)
    })

    return () => {
      isCancelled = true
      draggingRef.current = false
      const runtime = runtimeRef.current
      if (!runtime) {
        return
      }
      runtime.pointerHandles.forEach((handle) => handle.remove())
      runtime.highlightHandle?.remove()
      runtime.view.destroy()
      runtimeRef.current = null
    }
  }, [config.clientId, config.layerUrl, config.portalUrl, config.where])

  const handleSignIn = async () => {
    if (!config.clientId) {
      setAuthStatus('Missing clientId query parameter for OAuth.')
      return
    }

    try {
      await esriId.getCredential(`${config.portalUrl}/sharing`, { oAuthPopupConfirmation: false })
      setIsSignedIn(true)
      setIframeAuthError(false)
      setAuthStatus('Signed in')
    } catch (error) {
      setIsSignedIn(false)
      setAuthStatus('Sign-in failed')
      if (isInIframe) {
        setIframeAuthError(true)
      }
      const message = error instanceof Error ? error.message : String(error)
      setStatusMessage(`OAuth sign-in failed: ${message}`)
    }
  }

  const handleSignOut = () => {
    esriId.destroyCredentials()
    setIsSignedIn(false)
    setAuthStatus('Signed out')
  }

  const handleCancel = () => {
    const runtime = runtimeRef.current
    if (!runtime?.selectedGeometry) {
      return
    }

    runtime.previewGeometry = null
    if (runtime.previewGraphic) {
      runtime.graphicsLayer.remove(runtime.previewGraphic)
      runtime.previewGraphic = null
    }
    if (runtime.handleGraphic) {
      runtime.handleGraphic.geometry = getHandlePoint(runtime.selectedGeometry)
    }
    if (runtime.centerGraphic && runtime.centroid) {
      runtime.centerGraphic.geometry = runtime.centroid
    }
    setScaleFactor(1)
    setStatusMessage('Preview canceled.')
  }

  const handleSave = async () => {
    const runtime = runtimeRef.current
    if (!runtime?.previewGeometry || runtime.selectedObjectId === null) {
      setStatusMessage('Nothing to save.')
      return
    }

    if (!isSignedIn) {
      setStatusMessage('Please sign in before saving edits.')
      return
    }

    const updateFeature = new Graphic({
      geometry: runtime.previewGeometry,
      attributes: {
        [runtime.objectIdField]: runtime.selectedObjectId,
      },
    })

    try {
      const editsResult = await runtime.layer.applyEdits({ updateFeatures: [updateFeature] })
      const updateResult = editsResult.updateFeatureResults?.[0]
      if (!updateResult || updateResult.error) {
        const error = updateResult?.error
        const errorText = error ? `${error.name ?? 'Error'}: ${error.message}` : 'Unknown edit error.'
        setStatusMessage(`Save failed: ${errorText}`)
        return
      }

      runtime.selectedGeometry = runtime.previewGeometry
      runtime.previewGeometry = null
      if (runtime.previewGraphic) {
        runtime.graphicsLayer.remove(runtime.previewGraphic)
        runtime.previewGraphic = null
      }
      runtime.centroid = getCentroid(runtime.selectedGeometry)
      runtime.baseDistance = Math.max(
        getDistance(runtime.centroid, getHandlePoint(runtime.selectedGeometry)),
        0.0001,
      )
      if (runtime.handleGraphic) {
        runtime.handleGraphic.geometry = getHandlePoint(runtime.selectedGeometry)
      }
      if (runtime.centerGraphic && runtime.centroid) {
        runtime.centerGraphic.geometry = runtime.centroid
      }
      setScaleFactor(1)
      setStatusMessage(`Saved update for ObjectID ${runtime.selectedObjectId}.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatusMessage(`Save failed: ${message}`)
    }
  }

  return (
    <div className="app-shell">
      <aside className="panel">
        <h1>Geometry Scale Tool</h1>
        <p className="panel-item">
          Layer: <a href={config.layerUrl}>{config.layerUrl}</a>
        </p>
        <p className="panel-item">Filter (where): {config.where}</p>
        <p className="panel-item">Portal: {config.portalUrl}</p>

        <div className="button-row">
          <button onClick={handleSignIn} disabled={isSignedIn || !config.clientId}>
            Sign in
          </button>
          <button onClick={handleSignOut} disabled={!isSignedIn}>
            Sign out
          </button>
        </div>

        <p className="panel-item">Auth status: {authStatus}</p>
        <p className="panel-item">
          Selected ObjectID: {selectedObjectId === null ? 'None' : selectedObjectId}
        </p>
        <p className="panel-item">Scale factor: {scaleFactor.toFixed(3)}x</p>

        <div className="button-row">
          <button onClick={handleSave}>Save</button>
          <button onClick={handleCancel}>Cancel</button>
        </div>

        <p className="status">{statusMessage}</p>

        {iframeAuthError && (
          <div className="iframe-warning">
            <p>
              OAuth sign-in failed inside this embedded frame. Open the tool in a new tab and sign in
              there.
            </p>
            <a href={window.location.href} target="_blank" rel="noreferrer">
              Open in new tab
            </a>
          </div>
        )}
      </aside>
      <main className="map-container" ref={mapDivRef} />
    </div>
  )
}

export default App
