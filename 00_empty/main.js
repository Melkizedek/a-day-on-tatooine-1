//the OpenGL context
var gl = null,
    program = null,
    postProcessProgram = null,
    resources = null;

var renderTargetFramebuffer = null;
var renderTargetColorTexture = null;
var renderTargetDepthTexture = null;

var width = 1024, height = 1024;

var timePrev = 0;

// camera control, set starting viewpoint here!
var cameraEnabled = false;
const camera = {
  rotation: {       // TODO fix y must never be 0! (normal matrix computation fails)
                    // TODO when enabling free camera during flight, view direction is reset to rotation (how to update rotation angles while computing flight camera rotations)
    x: 3.85,
    y: 149.55
  },
  position: {
    x: -500,
    y: -500,
    z: -100
  },
  direction: {
    x: 0,
    y: 0,
    z: 0
  },
  speed: 30  // TODO choose speed
};

// descripes the current camera flight plan
const flight = {
  // two types:
  // flying in a straight line
  straight: false,
  // circling around a point
  circling: false,
  // parameters:
  // duration in milliseconds
  duration: 0,
  // starting point of flight
  origin: vec3.fromValues(0,0,0),
  // point to reach/circle around
  target: vec3.fromValues(0,0,0),
  // circling only: degrees turned
  degrees: 0.0,
  // function that is called after the destination is reached/degrees circled
  callback: function() {},
  // convenience: information about next flight (see straight calculations in render)
  next: "",
  nextTarget: vec3.fromValues(0,0,0),
  // specifies that 100/turnPart % of duration are dedicated to camera orientation towards the target
  turnPart: 0
}

// scenegraph
var root = null, postProcess = null;
var light2TranNode;
var light2TranY = 0;

/**
 * initializes OpenGL context, compile shader, and load buffers
 */
function init(resources) {
  //create a GL context
  gl = createContext(width /*width*/, height /*height*/); // TODO which width and height?

  gl.enable(gl.DEPTH_TEST);

  //compile and link shader program
  program = createProgram(gl, resources.vs, resources.fs);
  postProcessProgram = createProgram(gl, resources.postProcessVs, resources.postProcessFs);

  this.resources = resources;

  // allow to texture rendering (for post processing)
  initRenderToTexture();

  //create scenegraph (set root and postProcess nodes)
  createSceneGraph(resources);

  initInteraction(gl.canvas);

  // define camera flight using bound callback functions
  setupFlight(true, false, 5000, 0, [0,-50,0], 0, 3, "circle", [100,0,100],
    // after finishing straight flight -> setup circling flight
    setupFlight.bind(this, false, true, 5000, 5000, [100,0,100], 360, 3, "straight", [500,-250,500],

      setupFlight.bind(this, true, false, 5000, 10000, [500,-250,500], 0, 3, "circle", [750,0,750],

        setupFlight.bind(this, false, true, 5000, 15000, [750,0,750], 360, 3, "straight", [2000,-500,0],

          setupFlight.bind(this, true, false, 5000, 20000, [2000,-500,0], 0, 3, "circle", [500,0,500],

            setupFlight.bind(this, false, true, 1200000, 25000, [500,0,500], 360*10, 3, "", [0,0,0],
              function() {cameraEnabled = true;}
            )
          )
        )
      )
    )
  );
}

function initRenderToTexture() {
  var depthTextureExt = gl.getExtension("WEBGL_depth_texture");
  if(!depthTextureExt) { alert('No depth texture support!!!'); return; }

  //generate color texture (required mainly for debugging and to avoid bugs in some WebGL platforms)
  renderTargetFramebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, renderTargetFramebuffer);

  //create color texture
  renderTargetColorTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, renderTargetColorTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  //create depth texture
  renderTargetDepthTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, renderTargetDepthTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, width, height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null);

  //bind textures to framebuffer
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, renderTargetColorTexture, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, renderTargetDepthTexture ,0);

  if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!=gl.FRAMEBUFFER_COMPLETE)
    {alert('Framebuffer incomplete!');}

  //clean up
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/**
  * sets the parameters to run a flight animation while rendering
  * @param callback: it is intended to use setupFlight.bind(this, ...parameters for next flight animation...) for this parameter, which after completing this flight (duration over) sets up the parameters for the next one.
  * This way arbitrary long sequences of flight animations can be defined before starting to render the movie.
  * for other parameters see flight datastructure
  */
function setupFlight(straight, circling, duration, startTime, target, degrees, turnPart, next, nextTarget, callback) {
  flight.straight = straight;
  flight.circling = circling;
  flight.duration = duration;
  flight.startTime = startTime;
  flight.origin = vec3.fromValues(camera.position.x, camera.position.y, camera.position.z);
  flight.target = target;
  flight.degrees = degrees;
  flight.turnPart = turnPart;
  flight.next = next;
  flight.nextTarget = nextTarget;
  flight.callback = callback;
}

/**
 * builds up the scenegraph and sets the root and postProcess nodes
 */
function createSceneGraph(resources) {
  // TODO maybe compact this whole stuff a little (make use of children constructor)

  root = new ShaderSGNode(program);
  let enableTexNode = new SetUniformSGNode('u_enableObjectTexture', true);

  // --------------------- camera test scene ------------------------
  let sphere = makeSphere();
  let sphereModelNode = new RenderSGNode(sphere);
  let sphereTexNode = new AdvancedTextureSGNode(resources.tex);
  let sphereMatNode = new MaterialSGNode();
  let sphereTranNode = new TransformationSGNode(glm.transform({translate: [0, 0, 0]}));

  let rect = makeRect(1.5, 1.3);
  let rectShaderNode = new ShaderSGNode(createProgram(gl, resources.whiteVs, resources.whiteFs));
  let rectModelNode = new RenderSGNode(rect);
  let rectTexNode = new AdvancedTextureSGNode(resources.tex);
  let rectMatNode = new MaterialSGNode();
  let rectTranNode = new TransformationSGNode(glm.transform({translate: [-6, -6, -6]}));

  let lightSphere = makeSphere(0.5, 20, 20);
  let lightModelNode = new RenderSGNode(lightSphere);
  let lightTexNode = new AdvancedTextureSGNode(resources.sunTex);
  let lightMatNode = new MaterialSGNode();
  let lightNode = new MyLightNode([300, -150, 300], 0, 30, [1,1,1]);

  let light2Sphere = makeSphere(20, 20, 20);
  let light2ModelNode = new RenderSGNode(light2Sphere);
  let light2Node = new MyLightNode([1000, -500, 1000], 1, 180, [0,1,0]);
  light2TranNode = new TransformationSGNode(glm.transform({}));
  // --------------------- camera test scene ------------------------

  // leia
  let leia = resources.leia;
  let leiaModelNode = new RenderSGNode(leia);
  let leiaTexNode = new AdvancedTextureSGNode(resources.leiaTex);   // TODO putting a texture doesn't really work here (whole texture used for every triangle?)
  let leiaMatNode = new MaterialSGNode();
  let leiaTranNode = new TransformationSGNode(glm.transform({translate: [100, -5, -100], rotateX: 180}));

  // sandcrawler
  // TODO add spotlight to sandcrawler graph
  // TODO must animate one part separately from rest of model....slide out and rotate platform from between body and crawlers (as some kind of stair...put opening with jawas onto lower body as texture)
  // TODO find crawler texture
  let sandcrawlerBody = makeSandcrawlerBody();
  let sandcrawlerCrawlersNode = composeCrawlerQuad(resources);
  let sandcrawlerPlatformModelNode = new RenderSGNode(makeRect(0.5, 0.25));
  let sandcrawlerBodyModelNode = new RenderSGNode(sandcrawlerBody);
  let sandcrawlerPlatformTexNode = new AdvancedTextureSGNode(resources.platformTex);
  let sandcrawlerPlatformTranNode = new TransformationSGNode(glm.transform({translate: [0.5, 0, 0.3], rotateX: -90}));
  let sandcrawlerBodyTexNode = new AdvancedTextureSGNode(resources.rustyMetalTex);
  let sandcrawlerCrawlersTranNode = new TransformationSGNode(glm.transform({translate: [0.5, -0.05, 0]}));    // position crawlers below body
  let sandcrawlerMatNode = new MaterialSGNode();
  let sandcrawlerTranNode = new TransformationSGNode(glm.transform({translate: [500, -50, 500], rotateX: 180, scale: 100}));


  // test terrain generation from heightmap
  let terrain = generateTerrain(resources.heightmap, 8, 8, 120);
  let terrainModelNode = new RenderSGNode(terrain);
  let terrainTexNode = new AdvancedTextureSGNode(resources.sandTex);
  let terrainMatNode = new MaterialSGNode();
  let terrainTranNode = new TransformationSGNode(glm.transform({translate: [0, 100, 0]}));

  // show terrain
  terrainTranNode.append(terrainMatNode);
  terrainMatNode.append(terrainTexNode);
  terrainTexNode.append(terrainModelNode);
  terrainTexNode.append(enableTexNode);
  root.append(terrainTranNode);

  // show sandcrawler
  sandcrawlerTranNode.append(sandcrawlerMatNode);
  sandcrawlerMatNode.append(sandcrawlerBodyTexNode);
  sandcrawlerMatNode.append(sandcrawlerCrawlersTranNode);
  sandcrawlerMatNode.append(sandcrawlerPlatformTranNode);
  sandcrawlerMatNode.append(enableTexNode);
  sandcrawlerCrawlersTranNode.append(sandcrawlerCrawlersNode);
  sandcrawlerPlatformTranNode.append(sandcrawlerPlatformTexNode);
  sandcrawlerPlatformTexNode.append(sandcrawlerPlatformModelNode);
  sandcrawlerBodyTexNode.append(sandcrawlerBodyModelNode);
  root.append(sandcrawlerTranNode);

  // show leia
  leiaTranNode.append(leiaMatNode);
  leiaMatNode.append(leiaTexNode);
  leiaTexNode.append(enableTexNode);
  leiaTexNode.append(leiaModelNode);
  root.append(leiaTranNode);

  sphereTranNode.append(sphereMatNode);
  sphereMatNode.append(sphereTexNode);
  sphereTexNode.append(enableTexNode);
  sphereTexNode.append(sphereModelNode);
  root.append(sphereTranNode);

  rectShaderNode.append(rectTranNode);
  rectTranNode.append(rectMatNode);
  rectMatNode.append(rectTexNode);
  rectTexNode.append(rectModelNode);
  rectTexNode.append(enableTexNode);
  root.append(rectShaderNode);

  lightNode.append(lightMatNode);
  lightMatNode.append(lightTexNode);
  lightTexNode.append(enableTexNode);
  lightTexNode.append(sphereModelNode);
  root.append(lightNode);

  light2Node.append(light2ModelNode);
  light2TranNode.append(light2Node);
  //root.append(light2TranNode);
  root.append(light2Node);
}

/**
  * returns a (manually composed) sandcrawler body
  */
function makeSandcrawlerBody() {
  // TODO texture coodinates and... actually find a texture to use!
  // TODO spotlights..?
  // TODO weird flickering...z-buffer fighting?

  // returns
  var vertices = [];
  var normal = [];
  var texture = [];
  var index = [];

  // every plane of the model has it's one vertices because for hard edges we want multiple normal vectors for a vertex!
  // back part of body is just a quad
  vertices.push(
    // side face
    0,0,0,  //0
    0,.75,0,  //1
    1,0,0,  //2
    1,.75,0,  //3
    // top face
    0,.75,0,  //4
    1,.75,0,  //5
    0,.75,.5, //6
    1,.75,.5, //7
    // other side face
    0,.75,.5, //8
    1,.75,.5, //9
    0,0,.5, //10
    1,0,.5, //11
    // backface
    0,0,0, //12
    0,.75,0, //13
    0,0,.5, //14
    0,.75,.5 //15
  )

  // back body texture coordinates
  texture.push(
    0,0,  0,1,  1,0,  1,1,
    0,0,  0,1,  1,0,  1,1,
    0,0,  0,1,  1,0,  1,1,
    0,0,  0,1,  1,0,  1,1
  )

  // now triangles
  index.push(
    // side face
    0,1,3,
    0,2,3,
    // top face
    4,6,7,
    7,5,4,
    // other side face
    8,9,10,
    10,11,9,
    // backface
    12,13,15,
    15,14,12
  )

  // front part of body ... trapezes
  vertices.push(
    // side face
    1,0,0, //16
    1,.75,0, //17
    1.6,.5,.1, //18
    1.6,.75,.1, //19
    // top face
    1,.75,0, //20
    1,.75,.5, //21
    1.6,.75,.1, //22
    1.6,.75,.4,   //23
    // other side face
    1,0,.5, //24
    1,.75,.5, //25
    1.6,.5,.4,  //26
    1.6,.75,.4, //27
    // top front face
    1.6,.5,.1, //28
    1.6,.75,.1, //29
    1.6,.5,.4, //30
    1.6,.75,.4, //31
    // bottom front face
    1,0,0, //32
    1.6,.5,.1, //33
    1,0,.5, //34
    1.6,.5,.4 //35
  )

  // front body texture coordinates
  texture.push(
    0,0,  0,1,  1,0,  1,1,
    0,0,  0,1,  1,0,  1,1,
    0,0,  0,1,  1,0,  1,1,
    0,0,  0,1,  1,0,  1,1,
    0,0,  0,1,  1,0,  1,1
  )

  // now triangles again
  index.push(
    // side face
    16,17,19,
    19,18,16,
    // top face
    20,21,23,
    23,22,20,
    // other side face
    24,25,27,
    27,26,24,
    // top front face
    28,29,31,
    31,30,28,
    // bottom front face
    32,33,35,
    35,34,32
  )

  // now build vertex - triangle datastructure to automatically compute normals
  // TODO put triangle vertex indices in correct order for normal computation
  var vertexTriangles = [];
  vertexTriangles.push([0,1,3,  0,3,2]);
  vertexTriangles.push([1,0,3]);
  vertexTriangles.push([2,0,3]);
  vertexTriangles.push([3,0,1,  3,0,2]);

  vertexTriangles.push([4,6,7,  4,7,5]);
  vertexTriangles.push([5,7,4]);
  vertexTriangles.push([6,4,7]);
  vertexTriangles.push([7,4,6,  7,5,4]);

  vertexTriangles.push([8,9,10]);
  vertexTriangles.push([9,8,10,  9,10,11]);
  vertexTriangles.push([10,8,9,  10,11,9]);
  vertexTriangles.push([11,10,9]);

  vertexTriangles.push([12,13,15,  12,15,14]);
  vertexTriangles.push([13,12,15]);
  vertexTriangles.push([14,15,12]);
  vertexTriangles.push([15,12,13,  15,14,12]);

  vertexTriangles.push([16,17,19,  16,19,18]);
  vertexTriangles.push([17,16,19]);
  vertexTriangles.push([18,19,16]);
  vertexTriangles.push([19,16,17,  19,18,16]);

  vertexTriangles.push([20,21,23,  20,23,22]);
  vertexTriangles.push([21,20,23]);
  vertexTriangles.push([22,23,20]);
  vertexTriangles.push([23,20,21,  23,22,20]);

  vertexTriangles.push([24,25,27,  24,27,26]);
  vertexTriangles.push([25,24,27]);
  vertexTriangles.push([26,27,24]);
  vertexTriangles.push([27,24,25,  27,26,24]);

  vertexTriangles.push([28,29,31, 28,31,30]);
  vertexTriangles.push([29,28,31]);
  vertexTriangles.push([30,31,28]);
  vertexTriangles.push([31,28,29,  31,30,28]);

  vertexTriangles.push([32,33,35,  32,35,34]);
  vertexTriangles.push([33,32,35]);
  vertexTriangles.push([34,35,32]);
  vertexTriangles.push([35,32,33,  35,34,32]);

  calculateNormals(vertexTriangles, vertices, normal, false);

  return {
    position: vertices,
    normal: normal,
    texture: texture,
    index: index
  };
}


/**
  * Returns the top scenegraph node of a quad with size fitting the sandcrawler
  */
function composeCrawlerQuad(resources) {
  // we need 5 rects
  var left = makeRect(0.25, 0.05);
  var bottom = makeRect(0.5, 0.25);
  var right = makeRect(0.25, 0.05);
  var front = makeRect(0.5, 0.05);
  var back = makeRect(0.5, 0.05);

  var root = new SGNode(
    new SetUniformSGNode('u_enableObjectTexture', true, [
      new TransformationSGNode(glm.transform({rotateX: 180}), new AdvancedTextureSGNode(resources.crawlerTex0, new RenderSGNode(front))),
      new TransformationSGNode(glm.transform({rotateX: 180, translate: [0,0,0.5]}), new AdvancedTextureSGNode(resources.crawlerTex0, new RenderSGNode(back))),
      new TransformationSGNode(glm.transform({rotateY: 90, translate: [-0.5, 0, 0.25]}), new AdvancedTextureSGNode(resources.crawlerTex1, new RenderSGNode(left))),
      new TransformationSGNode(glm.transform({rotateY: 90, translate: [0.5, 0, 0.25]}), new AdvancedTextureSGNode(resources.crawlerTex1, new RenderSGNode(right))),
      new TransformationSGNode(glm.transform({rotateX: -90, translate: [0, -0.05, 0.25]}), new AdvancedTextureSGNode(resources.crawlerTex1, new RenderSGNode(bottom)))
  ]));

  return root;
}


/**
 * generates a planar terrain model generated from a given heightmap
 * @param heightmap: a greyscale image where darker == lower and lighter == higher terrain
 * @param stepX|Y: how many pixels to skip in x|y direction when parsing the heightmap (must divide heightmap width|height)
 * @param heightModifier: resulting height is [0, 1] * heightScaling
 */
// TODO as I realized now - this should have been done in a vertex shader D:
function generateTerrain(heightmap, stepX, stepY, heightScaling) {
  // TODO fix stepX|Y == (1,4,?) does not work! (incorrect triangle indices most likely)

  if(heightmap.width % stepX != 0 || heightmap.height % stepY != 0) {
    return null;
  }

  // Create a Canvas element
  var canvas = document.createElement('canvas');

  // Size the canvas to the element
  canvas.width = heightmap.width;
  canvas.height = heightmap.height;

  // Draw image onto the canvas
  var ctx = canvas.getContext('2d');
  ctx.drawImage(heightmap, 0, 0);

  // Finally, get the image data
  // ('data' is an array of RGBA pixel values for each pixel) ... 1 pixel is 4 sequential values in the array
  var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  // to calculate vertex normals later
  var vertexTriangles = [];
  // returns
  var vertices = [];
  var normal = [];
  var texture = [];
  var index = [];

  // current texture coordinates to set
  var currentTC0 = 1;
  var currentTC1 = 0;

  // iterate through image data, skipping according to resolution
  var meshWidth = heightmap.width / stepX + 1;
  var vertexIndex = 0;
  var y = 0, x = 0;
  var lastLine = false;
  while(y < heightmap.height) {
    if(x >= heightmap.width) {
      y += stepY;
      x = 0;

      // to always incorporate the last line of the heightmap into our mesh
      if(y == heightmap.height && stepY != 1) {
        lastLine = true;
        y--;
      }
    } else {

      var i = y * heightmap.width * 4 + x * 4;
      var z = data[i] / 255 * heightScaling;  // deduct z-Value [0, 1] from R-value of pixel (G and B-values in data[i+1..3] are assumed to be equal in greyscale heightmap!);
      //console.log(i + ": (" + data[i] + ", " + data[i+1] + ", " + data[i+2] + ", " + data[i+3] + ")");
      //console.log(z);
      // save vertex
      vertices.push(x, -z, y);   // height of image is height (y) of terrain

      // texture coordinates:
      //
      //  01___11___01___11_  ...
      //   |  /|   /|   /|
      //   | / |  / |  / |
      //  00___10___00___10_
      //   |  /|   /|   /|
      //   | / |  / |  / |
      //  01___11___01___11_
      //   |   |    |    |
      //  ...
      //
      texture.push(currentTC0, currentTC1);
      if(currentTC0 == 0 && currentTC1 == 0) {
        currentTC0 = 1;
        currentTC1 = 0;
      } else if(currentTC0 == 0 && currentTC1 == 1) {
        currentTC0 = 1;
        currentTC1 = 1;
      } else if(currentTC0 == 1 && currentTC1 == 0) {
        currentTC0 = 0;
        currentTC1 = 0;
      } else if(currentTC0 == 1 && currentTC1 == 1) {
        currentTC0 = 0;
        currentTC1 = 1;
      }


      // now the harder part: building triangles:
      // from every vertex start 2 triangles: type A = {i, i+1, i+meshWidth} and type B = {i, i+width, i+meshWidth-1}   (meshWidth == vertices in a line)
      // but: no type B triangle from first vertex in line, not type A triangle from last vertex in line, no triangles from vertices in last line
      // this is because we build a plane and not something voluminous
      if(!lastLine) {
        // not in last line

        if(x > 0) {
          // not first vertex in line
          // push type B
          index.push(vertexIndex, vertexIndex + meshWidth, vertexIndex + meshWidth - 1);
          // add texture coordinates
          /*texture.push( 0, 0,
                        1, 0,
                        1, 1);*/
          // keep track of all triangles adjacent to a vertex to compute normals later
          if(!vertexTriangles[vertexIndex]) {
            vertexTriangles[vertexIndex] = [];
          }
          vertexTriangles[vertexIndex].push(vertexIndex, vertexIndex + meshWidth, vertexIndex + meshWidth - 1);
          if(!vertexTriangles[vertexIndex+meshWidth]) {
            vertexTriangles[vertexIndex+meshWidth] = [];
          }
          vertexTriangles[vertexIndex+meshWidth].push(vertexIndex + meshWidth, vertexIndex + meshWidth - 1, vertexIndex);
          if(!vertexTriangles[vertexIndex+meshWidth-1]) {
            vertexTriangles[vertexIndex+meshWidth-1] = [];
          }
          vertexTriangles[vertexIndex+meshWidth-1].push(vertexIndex + meshWidth - 1, vertexIndex, vertexIndex + meshWidth);
        }

        if(x < heightmap.width - 1) {
          // not last vertex in line
          // push type A
          index.push(vertexIndex, vertexIndex + 1, vertexIndex + meshWidth);
          // add texture coordinates
          /*texture.push( 0, 0,
                        0, 1,
                        1, 1);*/
          // keep track of all triangles adjacent to a vertex to compute normals later
          if(!vertexTriangles[vertexIndex]) {
            vertexTriangles[vertexIndex] = [];
          }
          vertexTriangles[vertexIndex].push(vertexIndex, vertexIndex + 1, vertexIndex + meshWidth);
          if(!vertexTriangles[vertexIndex+1]) {
            vertexTriangles[vertexIndex+1] = [];
          }
          vertexTriangles[vertexIndex+1].push(vertexIndex + 1, vertexIndex + meshWidth, vertexIndex);
          if(!vertexTriangles[vertexIndex+meshWidth]) {
            vertexTriangles[vertexIndex+meshWidth] = [];
          }
          vertexTriangles[vertexIndex+meshWidth].push(vertexIndex + meshWidth, vertexIndex, vertexIndex + 1);

        } else {
            // last vertex in line - set new texture coordinates for next line!
            if(currentTC0 == 1 && currentTC1 == 1 || currentTC0 == 0 && currentTC1 == 1) {
              currentTC0 = 0;
              currentTC1 = 0;
            } else if(currentTC0 == 0 && currentTC1 == 0 || currentTC0 == 1 && currentTC1 == 0) {
              currentTC0 = 0;
              currentTC1 = 1;
            }
        }
      }

      vertexIndex++;
      x += stepX;

      // to always incorporate the last column of the heightmap into our mesh
      if(x == heightmap.width && stepX != 1) {
        x--;
      }
    }
  }

  // calculate terrain normals
  calculateNormals(vertexTriangles, vertices, normal, false);

  return {
    position: vertices,
    normal: normal,
    texture: texture,
    index: index
  };
}

/**
 * calculates the normal vector of every vertex by weighting in the surface normals of all adjacent triangles!
 * @param: vertexTriangles: two-dimensional array that contains triangles in form of vertex indices in the vertices parameter such that: vertexTriangles[123] == triangles adjacent to vertices[123]
                            IMPORTANT: the 3 vertex indices representing each adjacent triangle are expected to always have the current vertex as first vertex and the other two in clockwise ordering around the current vertex
                            an absolute ordering like this is necessary for proper normal calculation as: a cross b != b cross a
 * @param: vertices: array of vertices where 3 sequential numbers constitute a vertex
 * @param: normal: the array where normals should be pushed into
 * @param: convenience flag, results in flipped normals
 */
function calculateNormals(vertexTriangles, vertices, normal, flip) {
  vertexTriangles.forEach(function(adjacentTriangles) {
    var sum = vec3.create();

    for(var i = 0; i < adjacentTriangles.length; i += 3) { // a triangle consists of 3 vertices
      var p0 = vec3.fromValues(vertices[3*adjacentTriangles[i]], vertices[3*adjacentTriangles[i]+1], vertices[3*adjacentTriangles[i]+2]);
      var p1 = vec3.fromValues(vertices[3*adjacentTriangles[i+1]], vertices[3*adjacentTriangles[i+1]+1], vertices[3*adjacentTriangles[i+1]+2]);
      var p2 = vec3.fromValues(vertices[3*adjacentTriangles[i+2]], vertices[3*adjacentTriangles[i+2]+1], vertices[3*adjacentTriangles[i+2]+2]);

      // calculate surface normal of triangle as cross product of two lines of the triangle
      var p0_p1 = vec3.subtract(vec3.create(), p0, p1);
      var p0_p2 = vec3.subtract(vec3.create(), p0, p2);
      var surfaceNormal;

      // if for some reason all your hand-entered triangles result in flipped normals... ;)
      if(flip) {
        surfaceNormal = vec3.cross(vec3.create(), p0_p2, p0_p1);
      } else {
        surfaceNormal = vec3.cross(vec3.create(), p0_p1, p0_p2);
      }

      // sum up all surface normals
      // note that the magnitude of the just calculated surface normal is directly proportional to the area of it's triangle
      // thus summing up all surface normals and normalizing the sum is essentially weighting in surface normals according to the area of their triangles
      vec3.add(sum, sum, surfaceNormal);
    }

    // and normalize the sum
    vec3.normalize(sum, sum);

    // we now have the normal vector of one vertex!
    normal.push(sum[0], sum[1], sum[2]);
  });
}


/**
 * render one frame (to the screen)
 */
function render(timeInMilliseconds) {
  //calculate delta time for animation
  //convert timeInMilliseconds in seconds
  var timeNow = timeInMilliseconds / 1000;
  var timeDelta = timeNow - timePrev;
  timePrev = timeNow;

  var viewMatrix;
  // camera flight - calculate view matrix
  // TODO don't repeat yourself
  // TODO keep looking in currentdirection if flight stops/interrupted
  // TODO clean up
  if(!cameraEnabled){
    if(flight.straight) {
      // move towards target,
      // how much of the complete flight duration has already passed?
      var flightCompleted = Math.min((timeInMilliseconds - flight.startTime) / flight.duration, 1);
      // allows flight stop, if start time hasn't been reached yet
      if(flightCompleted < 0) {
        flightCompleted = 0;
      }
      // flight route
      var originToTarget = vec3.subtract(vec3.create(), flight.target, flight.origin);
      // calculate the part of the route we should have completed at this time
      var completedRoute = vec3.scale(vec3.create(), originToTarget, flightCompleted);
      // calculate the position we should be on
      var position = vec3.add(vec3.create(), completedRoute, flight.origin);
      // set this as our position
      camera.position.x = position[0];
      camera.position.y = position[1];
      camera.position.z = position[2];

      // rotate view towards target, calculation: CURRENTTARGET = CURRENTDIR + (CURRENTDIR_TO_TARGET) * FLIGHTCOMPLETED, (currentTarget approaches target as flightCompleted approaches 1)
      var currentDirToTarget = vec3.subtract(vec3.create(), flight.target, vec3.fromValues(camera.direction.x, camera.direction.y, camera.direction.z));
      var currentTarget = vec3.add(vec3.create(), vec3.fromValues(camera.direction.x, camera.direction.y, camera.direction.z), vec3.scale(vec3.create(), currentDirToTarget, Math.min(flightCompleted * flight.turnPart, 1)));

      // turn towards next flight target within this flight if next flight is circling (easier to implement here...)
      if(flight.next === 'circle' && flightCompleted >= (1 - 1/flight.turnPart)) {
        currentDirToTarget = vec3.subtract(vec3.create(), flight.nextTarget, currentTarget);
        currentTarget = vec3.add(vec3.create(), currentTarget, vec3.scale(vec3.create(), currentDirToTarget, Math.min((flightCompleted - 1 + 1/flight.turnPart) * flight.turnPart, 1)));
      }

      // finally build lookAt matrix after calculating movement and rotation
      viewMatrix = mat4.lookAt(mat4.create(), [camera.position.x, camera.position.y, camera.position.z], currentTarget, [0,1,0]);

      //console.log("rotationx: " + camera.rotation.x.toFixed(2) + "  |  rotationy: " + camera.rotation.y.toFixed(2) + "  |  x:" + camera.position.x.toFixed(2) + " y:" + camera.position.y.toFixed(2) + " z:" + camera.position.z.toFixed(2) + "  |  dirx:" + camera.direction.x.toFixed(2) + " diry:" + camera.direction.y.toFixed(2) + " dirz:" + camera.direction.z.toFixed(2));

      if(flightCompleted == 1) {
        // update camera direction to smoothly turn again to new target
        camera.direction.x = flight.target[0];
        camera.direction.y = flight.target[1];
        camera.direction.z = flight.target[2];
        // initiate next flight when we reached our position
        flight.callback();
      }

    } else if(flight.circling) {
      // circle around given target in current distance from target for given degrees
      // how much of the complete flight duration has already passed?
      var flightCompleted = Math.min((timeInMilliseconds - flight.startTime) / flight.duration, 1);
      if(flightCompleted < 0) {
        flightCompleted = 0;
      }

      var radius = Math.abs(vec3.distance(vec3.fromValues(camera.position.x, camera.position.y, camera.position.z), vec3.fromValues(flight.target[0], camera.position.y, flight.target[2]))); // note as we circle on our current y position, we actually calculate a circle and not a sphere

      // avoid jump on start of circling by calculating which rotation is equivalent to the current position in the orbit of the target
      var initialDeg = Math.acos((flight.origin[0] - flight.target[0])/radius) * (180/Math.PI);
      var initialDeg2 = Math.asin((flight.origin[2] - flight.target[2])/radius) * (180/Math.PI);   // TODO why is this not the same as initalDeg
      // how many degrees should we have rotated at this point?
      var currentDegrees = flight.degrees * flightCompleted - initialDeg;

      // calculate the x,z point on the target orbit for the current degrees
      camera.position.x = flight.target[0] + radius*Math.cos(glm.deg2rad(currentDegrees));
      camera.position.z = flight.target[2] + radius*Math.sin(glm.deg2rad(currentDegrees));

      // and plug them into lookat
      viewMatrix = mat4.lookAt(mat4.create(), [camera.position.x, camera.position.y, camera.position.z], flight.target, [0,1,0]);

      //console.log("rotationx: " + camera.rotation.x.toFixed(2) + "  |  rotationy: " + camera.rotation.y.toFixed(2) + "  |  x:" + camera.position.x.toFixed(2) + " y:" + camera.position.y.toFixed(2) + " z:" + camera.position.z.toFixed(2) + "  |  dirx:" + camera.direction.x.toFixed(2) + " diry:" + camera.direction.y.toFixed(2) + " dirz:" + camera.direction.z.toFixed(2));

      // initiate next flight when we reached our position
      if(flightCompleted == 1) {
        // update camera direction to smoothly turn again to new target
        camera.direction.x = flight.target[0];
        camera.direction.y = flight.target[1];
        camera.direction.z = flight.target[2];

        flight.callback();
      }
    }
  // free camera
  } else {
    // free moving camera: https://sidvind.com/wiki/Yaw,_pitch,_roll_camera
    // gl-matrix doc: http://glmatrix.net/docs/mat4.html
    let center = [camera.position.x + Math.cos(camera.rotation.x) * Math.sin(camera.rotation.y), camera.position.y + Math.cos(camera.rotation.y), camera.position.z + Math.sin(camera.rotation.y) * Math.sin(camera.rotation.x)];
    // generate view matrix from position, center and up
    viewMatrix = mat4.lookAt(mat4.create(), [camera.position.x, camera.position.y, camera.position.z], center, [0,1,0]);

    // extract normalized direction vector generated by lookAt - used to move in pointed direction
    camera.direction.x = viewMatrix[2];
    camera.direction.y = viewMatrix[6];
    camera.direction.z = viewMatrix[10];
    //console.log("rotationx: " + camera.rotation.x.toFixed(2) + "  |  rotationy: " + camera.rotation.y.toFixed(2) + "  |  x:" + camera.position.x.toFixed(2) + " y:" + camera.position.y.toFixed(2) + " z:" + camera.position.z.toFixed(2) + "  |  dirx:" + camera.direction.x.toFixed(2) + " diry:" + camera.direction.y.toFixed(2) + " dirz:" + camera.direction.z.toFixed(2));
  }
  // view matrix calculated!



  // first render to texture
  gl.bindFramebuffer(gl.FRAMEBUFFER, renderTargetFramebuffer);
  //setup viewport
  gl.viewport(0, 0, width, height);
  gl.clearColor(0.9, 0.9, 0.9, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  //setup context and camera matrices
  const context = createSGContext(gl);
  // TODO which Field of view/other parameters?
  context.projectionMatrix = mat4.perspective(mat4.create(), 50, gl.drawingBufferWidth / gl.drawingBufferHeight, 1, 5000);
  context.viewMatrix = viewMatrix;
  //render scenegraph (into framebuffer)
  root.render(context);
  //disable framebuffer (render to screen again)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);



  // do post processing (rendering framebuffer to screen using post process shader)
  //setup viewport
  gl.viewport(0, 0, width, height);
  gl.clearColor(0.9, 0.9, 0.9, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  //activate the post processing shader
  gl.useProgram(postProcessProgram);
  // set some shader parameters
  gl.uniform1f(gl.getUniformLocation(postProcessProgram, 'time'), timeInMilliseconds/1000);
  gl.uniform1f(gl.getUniformLocation(postProcessProgram, 'distortionFactor'), 0.015);
  gl.uniform1f(gl.getUniformLocation(postProcessProgram, 'riseFactor'), 0.75);
  // set the texture to render in the shader
  gl.uniform1i(gl.getUniformLocation(postProcessProgram, 'u_sceneTex'), 0); // texture unit 0
  // set the depthmap
  gl.uniform1i(gl.getUniformLocation(postProcessProgram, 'u_depthMap'), 1); // texture unit 1

  // create a texture from distortionmap as image
  gl.activeTexture(gl.TEXTURE0 + 2);  // texture unit 2
  var distortionMap = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, distortionMap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);  // repeat needed for shader effect
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, resources.distortionMap);

  gl.uniform1i(gl.getUniformLocation(postProcessProgram, 'u_distortionMap'), 2); // texture unit 2
  //activate/select texture unit and bind texture
  gl.activeTexture(gl.TEXTURE0 + 0);
  gl.bindTexture(gl.TEXTURE_2D, renderTargetColorTexture);
  gl.activeTexture(gl.TEXTURE0 + 1);
  gl.bindTexture(gl.TEXTURE_2D, renderTargetDepthTexture);
  // build a fullscreen quad on which we'll render the scene in the framebuffer
  var buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const arr = new Float32Array([
    -1.0, -1.0,
    1.0, -1.0,
    -1.0, 1.0,
    -1.0, 1.0,
    1.0, -1.0,
    1.0, 1.0]);
  //copy data to GPU
  gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
  const positionLocation = gl.getAttribLocation(postProcessProgram, 'a_position');
  gl.enableVertexAttribArray(positionLocation);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  //request another call as soon as possible
  requestAnimationFrame(render);
}

//load the shader resources using a utility function
loadResources({
  // shaders
  vs: 'shader/phong.vs.glsl',
  fs: 'shader/phong.fs.glsl',
  postProcessVs: 'shader/heatshimmer.vs.glsl',
  postProcessFs: 'shader/heatshimmer.fs.glsl',
  distortionMap: 'assets/distortion_map.jpg',

  // test different shader TODO remove
  whiteVs : 'shader/white.vs.glsl',
  whiteFs : 'shader/white.fs.glsl',

  // terrain
  heightmap: 'assets/terrain/heightmap.png',
  sandTex: 'assets/sand.jpg',

  // other textures
  tex: 'assets/lava.jpg',
  sunTex: 'assets/sun.jpg',
  leiaTex: 'assets/models/leia/Leia/Leia Textures/Leia_Diff.png',
  rustyMetalTex: 'assets/rusty_metal.jpg',
  crawlerTex0: 'assets/crawlers0.jpg',
  crawlerTex1: 'assets/crawlers1.jpg',
  platformTex: 'assets/platform.jpg',
  testTex: 'assets/test.jpg',

  // models
  leia: 'assets/models/leia/Leia/Leia.obj'


}).then(function (resources /*an object containing our keys with the loaded resources*/) {
  init(resources);

  //render one frame
  render(0);
});

//camera control
function initInteraction(canvas) {
  const mouse = {
    pos: { x : 0, y : 0},
    leftButtonDown: false
  };
  function toPos(event) {
    //convert to local coordinates
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }
  canvas.addEventListener('mousedown', function(event) {
      mouse.pos = toPos(event);
      mouse.leftButtonDown = event.button === 0;
  });
  canvas.addEventListener('mousemove', function(event) {
    const pos = toPos(event);
    const delta = { x : mouse.pos.x - pos.x, y: mouse.pos.y - pos.y };
    if (mouse.leftButtonDown && cameraEnabled) {
      //add the relative movement of the mouse to the rotation variables
  		camera.rotation.x -= delta.x / 1000;
      camera.rotation.y += delta.y / 1000;
    }
    mouse.pos = pos;
  });
  canvas.addEventListener('mouseup', function(event) {
    mouse.pos = toPos(event);
    mouse.leftButtonDown = false;
  });
  //register globally
  document.addEventListener('keypress', function(event) {
    //https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent
    if (event.code === 'KeyR') {
      camera.rotation.x = 0;
  		camera.rotation.y = 0;
    }

    if (event.code === 'KeyC') {
      cameraEnabled = !cameraEnabled;
    }
  });

  // forward/backward movement
  // TODO not sure if working correctly (passing through some axis)
  document.addEventListener('keydown', function(event) {
    if(event.code === 'ArrowUp' && cameraEnabled) {
      camera.position.x -= camera.direction.x * camera.speed;
      camera.position.y -= camera.direction.y * camera.speed;
      camera.position.z -= camera.direction.z * camera.speed;

    } else if(event.code === 'ArrowDown' && cameraEnabled) {
      camera.position.x += camera.direction.x * camera.speed;
      camera.position.y += camera.direction.y * camera.speed;
      camera.position.z += camera.direction.z * camera.speed;
    }
  })
}

/**
  * extended light node implementation - supports multiple lightsources and spotlights - only use this from now on
  * every light is a spotlight - use >= 180 angle for directional light
  * @param index: every lightnode must have an index that is unique over all lightnodes - also must be < MAX_LIGHTS in shaders
  * @param coneAngle: the cone of the spotlight has an angle of +- coneAngle from coneDirection
  * @param coneDirection: center of the spotlight cone, doesn't have to be normalized
  */
class MyLightNode extends TransformationSGNode {

  constructor(position, index, coneAngle, coneDirection, children) {
    super(children);
    this.position = position || [0, 0, 0];
    this.ambient = [0, 0, 0, 1];
    this.diffuse = [1, 1, 1, 1];
    this.specular = [1, 1, 1, 1];

    this.index = index;
    this.uniform = 'u_light';

    this.coneAngle = coneAngle;
    this.coneDirection = coneDirection;

    this._worldPosition = null;
  }

  setLightUniforms(context) {
    const gl = context.gl;
    //no materials in use
    if (!context.shader || !isValidUniformLocation(gl.getUniformLocation(context.shader, this.uniform + '[' + this.index + ']' + '.ambient'))) {
      return;
    }
    gl.uniform4fv(gl.getUniformLocation(context.shader, this.uniform + '[' + this.index + ']' + '.ambient'), this.ambient);
    gl.uniform4fv(gl.getUniformLocation(context.shader, this.uniform + '[' + this.index + ']' + '.diffuse'), this.diffuse);
    gl.uniform4fv(gl.getUniformLocation(context.shader, this.uniform + '[' + this.index + ']' + '.specular'), this.specular);

    gl.uniform1f(gl.getUniformLocation(context.shader, this.uniform + '[' + this.index + ']' + '.coneAngle'), this.coneAngle);
    gl.uniform3fv(gl.getUniformLocation(context.shader, this.uniform + '[' + this.index + ']' + '.coneDirection'), this.coneDirection);
  }

  setLightPosition(context) {
    const gl = context.gl;
    if (!context.shader || !isValidUniformLocation(gl.getUniformLocation(context.shader, this.uniform+'Pos' + '[' + this.index + ']'))) {
      return;
    }
    const position = this._worldPosition || this.position;
    gl.uniform3f(gl.getUniformLocation(context.shader, this.uniform+'Pos[' + this.index + ']'), position[0], position[1], position[2]);
    // and for spotlights
    gl.uniform3f(gl.getUniformLocation(context.shader, this.uniform+'PosOriginal[' + this.index + ']'), this.position[0], this.position[1], this.position[2]);
  }

  computeLightPosition(context) {
    //transform with the current model view matrix
    const modelViewMatrix = mat4.multiply(mat4.create(), context.viewMatrix, context.sceneMatrix);
    const original = this.position;
    const position =  vec4.transformMat4(vec4.create(), vec4.fromValues(original[0], original[1],original[2], 1), modelViewMatrix);

    this._worldPosition = position;
  }

  /**
   * set the light uniforms without updating the last light position
   */
  setLight(context) {
    this.setLightPosition(context);
    this.setLightUniforms(context);
  }

  render(context) {
    this.computeLightPosition(context);
    this.setLight(context);

    //since this a transformation node update the matrix according to my position
    this.matrix = glm.translate(this.position[0], this.position[1], this.position[2]);
    //render children
    super.render(context);
  }
}
