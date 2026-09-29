/** FoidMommy — Decorative animated mascot component used for empty states and loading screens. */
"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { useRef, useEffect, useState, useMemo } from "react";
import * as THREE from "three";

// Shared mouse state across all components in the Canvas
const mouseState = { x: 0, y: 0 };

function useMouseTracker() {
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      mouseState.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouseState.y = -(e.clientY / window.innerHeight) * 2 + 1;
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);
}

function FoidModel() {
  const { scene } = useGLTF("/foidmommy.glb");
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (!groupRef.current) return;
    const targetRotY = mouseState.x * 0.4;
    const targetRotX = -mouseState.y * 0.3;
    groupRef.current.rotation.y += (targetRotY - groupRef.current.rotation.y) * 0.05;
    groupRef.current.rotation.x += (targetRotX - groupRef.current.rotation.x) * 0.05;
  });

  return (
    <group ref={groupRef} position={[0, -0.5, 0]}>
      <primitive object={scene} scale={1.8} />
    </group>
  );
}

// Single orbiting golden bot
function SwarmBot({ index, total }: { index: number; total: number }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const angle = (index / total) * Math.PI * 2;
  const radius = 2.8 + (index % 3) * 0.4; // Stagger radius slightly
  const yOffset = (index % 2 === 0 ? 0.3 : -0.3) + Math.sin(index * 1.2) * 0.5;
  const speed = 0.15 + (index % 4) * 0.05;
  const size = 0.15 + (index % 3) * 0.04;

  const material = useMemo(() => new THREE.MeshStandardMaterial({
    color: new THREE.Color("#FFD700"),
    metalness: 0.9,
    roughness: 0.15,
    emissive: new THREE.Color("#FF8C00"),
    emissiveIntensity: 0.3,
  }), []);

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime * speed;
    const currentAngle = angle + t;

    // Orbit position
    meshRef.current.position.x = Math.cos(currentAngle) * radius;
    meshRef.current.position.z = Math.sin(currentAngle) * radius;
    meshRef.current.position.y = yOffset + Math.sin(t * 2 + index) * 0.3;

    // Rotate toward mouse
    const targetRotY = mouseState.x * 0.6;
    const targetRotX = -mouseState.y * 0.4;
    meshRef.current.rotation.y += (targetRotY + currentAngle - meshRef.current.rotation.y) * 0.08;
    meshRef.current.rotation.x += (targetRotX - meshRef.current.rotation.x) * 0.08;
  });

  return (
    <mesh ref={meshRef} material={material}>
      <dodecahedronGeometry args={[size, 1]} />
    </mesh>
  );
}

// Glow ring around the swarm
function GlowRing() {
  const ringRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!ringRef.current) return;
    ringRef.current.rotation.x = Math.PI / 2 + mouseState.y * 0.15;
    ringRef.current.rotation.z = state.clock.elapsedTime * 0.05;
  });

  return (
    <mesh ref={ringRef} position={[0, 0, 0]}>
      <torusGeometry args={[3, 0.015, 8, 64]} />
      <meshStandardMaterial
        color="#FFD700"
        emissive="#FFD700"
        emissiveIntensity={0.5}
        transparent
        opacity={0.3}
      />
    </mesh>
  );
}

export default function FoidMommy() {
  const [mounted, setMounted] = useState(false);
  useMouseTracker();

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <Canvas
      camera={{ position: [0, 0, 6], fov: 50 }}
      style={{ width: "100%", height: "100%" }}
      gl={{ alpha: true, antialias: true }}
    >
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 5, 5]} intensity={1.2} />
      <directionalLight position={[-3, 2, -2]} intensity={0.4} />
      <pointLight position={[0, 0, 3]} intensity={0.8} color="#FFD700" />

      {/* Center: FoidMommy */}
      <FoidModel />

      {/* Orbiting swarm bots */}
      {Array.from({ length: 10 }, (_, i) => (
        <SwarmBot key={i} index={i} total={10} />
      ))}

      {/* Subtle glow ring */}
      <GlowRing />
    </Canvas>
  );
}

useGLTF.preload("/foidmommy.glb");
